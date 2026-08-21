'use strict';
// Argument validation for M-Ai tools. Platform-agnostic: nothing in this file
// knows what a lead, a ticket or a ringgit is.
//
// ── Provenance ─────────────────────────────────────────────────────────────
// This is M-EasyCommerce's `src/services/secretary/validate.js`, read as a
// reference pattern and re-authored here verbatim in behaviour. It is the piece
// of the framework with the least platform in it, so re-deriving it would have
// been re-deriving a solved problem — and the two files diverging is the thing
// the eventual @modus/mai extraction has to avoid. Nothing was "improved" on
// the way across, deliberately: a silent behaviour difference between two copies
// of a validator is the hardest kind of bug to see.
//
// Deliberately NOT ajv. This module is meant to be lifted into a shared package
// used by nine platforms, and a schema validator is the kind of dependency that
// is trivial to add and painful to remove. The subset below is everything a
// tool-call argument list actually needs; anything richer is a sign the tool is
// taking too many arguments.
//
// Supported: type object with `properties` and `required`; property types
// string | integer | number | boolean | array | object; and the constraints
// enum, minimum, maximum, minLength, maxLength, minItems, maxItems, default.
//
// Two behaviours worth knowing, both chosen because the input comes from a
// language model rather than from code:
//
//   1. Unknown keys are STRIPPED, not rejected. A model that invents an extra
//      argument should not turn a good tool selection into a refusal — but the
//      executor must never see the invented key either, so it is dropped and
//      reported in `ignored`. This is also a security property, not only a
//      convenience: an executor can never be handed an `ownerId`, a `role` or a
//      `table` the model made up, because a key the schema does not declare
//      does not survive this function.
//   2. Numeric and boolean strings are COERCED ("5" → 5, "true" → true). Models
//      routinely emit numbers as strings, and refusing over that would be a
//      refusal caused by formatting rather than by meaning. Coercion is strict:
//      only a string that is entirely a valid number converts, so "5 items"
//      stays a string and fails against an integer type, as it should.

const TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object']);
const MAX_DEPTH = 3;
// A model asked for "every lead" will happily emit a 500-element array. The cap
// is per-array and applies when the schema does not set its own maxItems.
const DEFAULT_MAX_ITEMS = 50;

function coerce(value, type) {
  if (type === 'integer' || type === 'number') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
    return value;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  return value;
}

function checkOne(key, value, spec, errors, depth = 0, ignored = null) {
  const type = spec && spec.type;
  if (!TYPES.has(type)) {
    errors.push(`${key}: schema declares unsupported type "${type}"`);
    return undefined;
  }

  if (depth > MAX_DEPTH) {
    errors.push(`${key}: schema nests deeper than the supported ${MAX_DEPTH} levels`);
    return undefined;
  }

  // ── array ───────────────────────────────────────────────────────────────
  // A single item where a list was asked for is WRAPPED rather than rejected.
  // Models routinely emit {ids: 4} instead of {ids: [4]}, and refusing over that
  // is a refusal caused by shape rather than by meaning — the same reasoning
  // behind coercing "5" to 5 above.
  if (type === 'array') {
    const raw = Array.isArray(value) ? value : [value];
    const maxItems = typeof spec.maxItems === 'number' ? spec.maxItems : DEFAULT_MAX_ITEMS;
    if (raw.length > maxItems) {
      errors.push(`${key}: ${raw.length} items exceeds the maximum ${maxItems}`);
      return undefined;
    }
    if (typeof spec.minItems === 'number' && raw.length < spec.minItems) {
      errors.push(`${key}: ${raw.length} items is below the minimum ${spec.minItems}`);
      return undefined;
    }
    if (!spec.items || !spec.items.type) {
      errors.push(`${key}: array schema must declare items with a type`);
      return undefined;
    }
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      // One bad element fails the whole argument. Silently dropping it would
      // narrow a filter the user asked for and report the result as though the
      // filter had been applied, which is a wrong answer wearing a right one.
      const item = checkOne(`${key}[${i}]`, raw[i], spec.items, errors, depth + 1, ignored);
      if (item === undefined) return undefined;
      out.push(item);
    }
    return out;
  }

  // ── nested object ───────────────────────────────────────────────────────
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${key}: expected an object, got ${JSON.stringify(value)}`);
      return undefined;
    }
    if (!spec.properties || typeof spec.properties !== 'object') {
      errors.push(`${key}: object schema must declare a properties map`);
      return undefined;
    }
    const req = Array.isArray(spec.required) ? spec.required : [];
    const out = {};
    for (const [k, s] of Object.entries(spec.properties)) {
      const present = Object.prototype.hasOwnProperty.call(value, k) && value[k] !== null && value[k] !== undefined;
      if (!present) {
        if (req.includes(k)) { errors.push(`${key}.${k}: required argument is missing`); return undefined; }
        if (Object.prototype.hasOwnProperty.call(s, 'default')) out[k] = s.default;
        continue;
      }
      const v2 = checkOne(`${key}.${k}`, value[k], s, errors, depth + 1, ignored);
      if (v2 === undefined) return undefined;
      out[k] = v2;
    }
    // Unknown keys are dropped here too, matching the top level — and REPORTED,
    // also matching the top level. `ignored` is how tool authors find out the
    // model is reaching for something they did not define, and a blind spot at
    // depth is a blind spot exactly where the arguments are most complex.
    if (Array.isArray(ignored)) {
      for (const k of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(spec.properties, k)) ignored.push(`${key}.${k}`);
      }
    }
    return out;
  }

  const v = coerce(value, type);

  if (type === 'integer') {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      errors.push(`${key}: expected an integer, got ${JSON.stringify(value)}`);
      return undefined;
    }
  } else if (type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${key}: expected a number, got ${JSON.stringify(value)}`);
      return undefined;
    }
  } else if (typeof v !== type) {
    errors.push(`${key}: expected ${type}, got ${JSON.stringify(value)}`);
    return undefined;
  }

  if (Array.isArray(spec.enum) && !spec.enum.includes(v)) {
    errors.push(`${key}: ${JSON.stringify(v)} is not one of ${JSON.stringify(spec.enum)}`);
    return undefined;
  }
  if (typeof spec.minimum === 'number' && v < spec.minimum) {
    errors.push(`${key}: ${v} is below the minimum ${spec.minimum}`);
    return undefined;
  }
  if (typeof spec.maximum === 'number' && v > spec.maximum) {
    errors.push(`${key}: ${v} is above the maximum ${spec.maximum}`);
    return undefined;
  }
  if (typeof spec.minLength === 'number' && typeof v === 'string' && v.length < spec.minLength) {
    errors.push(`${key}: shorter than the minimum length ${spec.minLength}`);
    return undefined;
  }
  if (typeof spec.maxLength === 'number' && typeof v === 'string' && v.length > spec.maxLength) {
    errors.push(`${key}: longer than the maximum length ${spec.maxLength}`);
    return undefined;
  }
  return v;
}

/**
 * @param {object} schema  JSON-Schema-ish object as registered on the tool.
 * @param {object} args    Arguments the model produced.
 * @returns {{ok:boolean, value:object, errors:string[], ignored:string[]}}
 *          `value` contains ONLY keys declared in the schema, so an executor
 *          can never be handed something the schema did not describe.
 */
function validateArgs(schema, args) {
  const errors = [];
  const ignored = [];

  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
    return { ok: false, value: {}, errors: ['schema must be an object schema with a properties map'], ignored };
  }
  // A model that emits malformed JSON gives us null here. That is a refusal,
  // not an empty argument list — `{}` would silently run the tool with defaults.
  if (args === null || args === undefined || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, value: {}, errors: ['arguments must be an object'], ignored };
  }

  const props = schema.properties;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const value = {};

  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) ignored.push(key);
  }

  for (const [key, spec] of Object.entries(props)) {
    const present = Object.prototype.hasOwnProperty.call(args, key) && args[key] !== null && args[key] !== undefined;
    if (!present) {
      if (required.includes(key)) {
        errors.push(`${key}: required argument is missing`);
      } else if (Object.prototype.hasOwnProperty.call(spec, 'default')) {
        value[key] = spec.default;
      }
      continue;
    }
    const v = checkOne(key, args[key], spec, errors, 0, ignored);
    if (v !== undefined) value[key] = v;
  }

  return { ok: errors.length === 0, value, errors, ignored };
}

module.exports = { validateArgs };
