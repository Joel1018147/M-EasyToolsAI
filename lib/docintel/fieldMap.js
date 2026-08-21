'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   THE ALLOW-LIST.                                      lib/docintel/fieldMap.js
   ───────────────────────────────────────────────────────────────────────────
   GUARD 3 lives here as DATA. Every table name, every column name and every
   normaliser in this feature is authored in this file. Nothing anywhere else
   in lib/docintel/ builds an identifier out of model output, out of a request
   body, or out of a document's text — `getField()` either returns a definition
   written below by a person, or null, and null means the proposal dies.

   That is the entire reason this is a map and not a lookup: a `columns[key]`
   over a table introspection would make every column in `users` reachable by
   naming it, and `password`, `api_key` and `groq_key` are all columns in
   `users`.

   ── THIS IS NOT M-EasyDo's MAP, AND COULD NOT BE ──────────────────────────
   GAUNTLET.md §R: "the guard sequence, nonce mechanism and evidence model are
   copied as DESIGN; the field map is necessarily this platform's own."
   M-EasyDo files documents onto leads, customers, appointments and members.
   This platform has none of those tables. What it has is press releases and a
   brand profile, and those are what a document can be filed onto here.

   ── WHY EVERY CATEGORY BELOW IS OWNER-SCOPED, AND TWO ARE ABSENT ──────────
   A category is only eligible if its table carries a per-user owner column,
   because the write is `… WHERE id=$2 AND <ownerColumn>=$3` and there is no
   other thing standing between one tenant and another. `journalists` and
   `media_outlets` are shared, staff-curated directories with no owner column
   at all, so a user's uploaded PDF must never be able to file into them —
   they are named in ABSENT_CATEGORIES with that reason rather than being
   silently missing, because a destination that is absent and one that is
   merely not listed look identical to the person looking for it.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── normalisers ───────────────────────────────────────────────────────────
   Each returns EITHER `{value}` OR `{reason}` — never both, and never a
   coerced best effort. A value the normaliser refuses is DROPPED with the
   refusal recorded on the auto-rejected row, so the reviewer sees that the
   model found something the schema could not hold, rather than seeing the
   field quietly absent.

   The presence of `value` is what the caller branches on (guards.verify uses
   hasOwnProperty), so a normaliser returning `{value: ''}` is a legitimate
   empty string and NOT the same thing as a refusal. */

/** Collapse the document's own whitespace without altering its characters. */
const tidy = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Free text with a hard length ceiling matching the column's own width. */
function text(maxLen, what) {
  return (raw) => {
    const v = tidy(raw);
    if (!v) return { reason: 'empty once whitespace is collapsed' };
    if (v.length > maxLen) {
      return { reason: `${v.length} characters, and ${what} holds at most ${maxLen}` };
    }
    return { value: v };
  };
}

/** A short label drawn from a FIXED vocabulary. Anything else is refused, not
 *  mapped to the nearest entry — guessing which of five audiences a document
 *  meant is exactly the inference this feature exists to stop a model making. */
function oneOf(allowed, what) {
  const lower = allowed.map((a) => a.toLowerCase());
  return (raw) => {
    const v = tidy(raw);
    if (!v) return { reason: 'empty once whitespace is collapsed' };
    const at = lower.indexOf(v.toLowerCase());
    if (at === -1) {
      return { reason: `not one of the ${what} this platform stores (${allowed.join(', ')})` };
    }
    /* The ALLOWED spelling, not the document's casing: this column is read
       back by code that compares it, and 'Malaysia' and 'malaysia' being two
       different regions is a defect. The document's own characters are still
       kept verbatim in raw_value and shown on the card. */
    return { value: allowed[at] };
  };
}

/* ── the categories ────────────────────────────────────────────────────────
   `table`, `ownerColumn` and every `column` below are the ONLY identifiers
   interpolated into SQL anywhere in this feature, and service.js re-checks
   each one against a lower-snake-case pattern before it reaches a query
   string. Belt and braces: the braces are that these are authored constants,
   the belt is that an identifier which is not one throws. */
const CATEGORIES = {
  pr_release: {
    key: 'pr_release',
    label: 'press release',
    table: 'pr_releases',
    ownerColumn: 'user_id',
    /* A press release is CREATED by /api/pr/generate, which writes the
       generated body and the scores. Document Intelligence only ever fills in
       the descriptive fields of a release that already exists — it cannot
       create one, because a pr_releases row without a headline and a company
       is not a valid row and inventing them from a document is precisely the
       inference the Human-Confirmation Bar forbids. */
    describe: 'Fills in the descriptive fields of a press release you have already drafted, '
            + 'from a brief, a fact sheet or a company boilerplate document.',
    fields: {
      company_name: {
        label: 'Company name',
        column: 'company_name',
        hint: 'the name of the company the release is about, exactly as printed',
        normalise: text(255, 'pr_releases.company_name'),
      },
      headline: {
        label: 'Headline',
        column: 'headline',
        hint: 'the release headline or title line',
        normalise: text(500, 'pr_releases.headline'),
      },
      spokesperson: {
        label: 'Spokesperson',
        column: 'spokesperson',
        hint: 'the named person quoted or available for comment',
        normalise: text(255, 'pr_releases.spokesperson'),
      },
      audience: {
        label: 'Audience',
        column: 'audience',
        hint: 'who the release is aimed at — one of: consumers, business, investors, media, government',
        normalise: oneOf(['consumers', 'business', 'investors', 'media', 'government'], 'audiences'),
      },
      region: {
        label: 'Region',
        column: 'region',
        hint: 'the market the release covers — one of: Malaysia, Singapore, Indonesia, Thailand, Global',
        normalise: oneOf(['Malaysia', 'Singapore', 'Indonesia', 'Thailand', 'Global'], 'regions'),
      },
    },
  },

  brand: {
    key: 'brand',
    label: 'brand profile',
    table: 'users',
    /* ownerColumn IS the primary key here, and the target id must equal the
       signed-in user's own id — enforced in service.js, not merely by the
       write's WHERE clause. A brand profile is a row in `users`, so the
       "which record" question has exactly one legal answer per session and
       the binding step is not free to name a different one.

       `users` also holds `password`, `api_key`, `groq_key`, `role` and
       `plan`. None of them appear below, and there is no code path that could
       reach one: a model naming `role` gets null from getField() and its
       proposal is auto-rejected with that reason recorded. */
    ownerColumn: 'id',
    selfOnly: true,
    describe: 'Fills in your brand profile from a brand guidelines document, a company profile or a '
            + 'tone-of-voice sheet. These three fields steer every generation on this platform.',
    fields: {
      brand_name: {
        label: 'Brand name',
        column: 'brand_name',
        hint: 'the brand or trading name, exactly as printed',
        normalise: text(255, 'users.brand_name'),
      },
      brand_desc: {
        label: 'Brand description',
        column: 'brand_desc',
        /* TEXT column, so the ceiling is a readability limit rather than a
           schema limit — a "description" that is four pages long is a
           document, not a description, and it is fed into every prompt. */
        hint: 'one or two sentences describing what the brand does and for whom',
        normalise: text(2000, 'a brand description that stays useful in a prompt'),
      },
      brand_tone: {
        /* The same column the workspace already edits beside the brand name.
           This is a WRITE PATH into it, not a second home for editing it —
           CLAUDE.md's objection is to one setting appearing under two names in
           two places, and nothing here renames or re-homes it. */
        label: 'Brand tone',
        column: 'brand_tone',
        hint: 'the tone of voice, in a word or two — e.g. Professional, Friendly, Bold',
        normalise: text(100, 'users.brand_tone'),
      },
    },
  },
};

/* ── recognised, and deliberately without a destination ────────────────────
   §4.2's rule, applied to destinations: a category that is present-but-empty
   and one that does not exist look identical to a user and mean completely
   different things. Each of these is a thing a person might genuinely try to
   file a document onto here, and each has a reason it cannot be one. */
const ABSENT_CATEGORIES = {
  journalist:
    'The `journalists` table is a shared, staff-curated ecosystem directory with no per-user owner column, so a '
    + 'document uploaded by one account cannot be filed onto it without editing a row every other account also '
    + 'reads. Journalists are maintained in the seller panel.',
  media_outlet:
    'The `media_outlets` table is a shared, staff-curated directory with no per-user owner column, for the same '
    + 'reason as journalists above.',
  invoice:
    'Invoices are a payment record. Nothing in this lane may write a billing or tax value — a wrong number there '
    + 'is a wrong charge, not a wrong draft.',
  contact:
    'This platform has no CRM. Contacts, leads and appointments live on M-EasyDo, not here, and offering the '
    + 'category would be offering a destination that does not exist.',
  document:
    'A generated document is the OUTPUT of this platform, written by the generation layer with its own word count '
    + 'and scores. Overwriting one from an uploaded file would silently detach it from the scores stored beside it.',
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);

function getCategory(key) {
  if (typeof key !== 'string') return null;
  /* Own-property lookup only. A category named `constructor` or `__proto__`
     must not resolve to something off Object.prototype and then be treated as
     a category definition. */
  return Object.prototype.hasOwnProperty.call(CATEGORIES, key) ? CATEGORIES[key] : null;
}

function getField(categoryKey, fieldKey) {
  const cat = getCategory(categoryKey);
  if (!cat || typeof fieldKey !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(cat.fields, fieldKey) ? cat.fields[fieldKey] : null;
}

/** Human-readable "where would this land", for the card and the audit row. */
function targetOf(categoryKey, fieldKey) {
  const cat = getCategory(categoryKey);
  const field = getField(categoryKey, fieldKey);
  if (!cat || !field) return null;
  return `${cat.table}.${field.column}`;
}

/** What the page renders its category picker from — the server's own truth,
 *  so a UI can never advertise a destination the server would refuse. */
function describe() {
  return {
    categories: CATEGORY_KEYS.map((k) => {
      const c = CATEGORIES[k];
      return {
        key: k,
        label: c.label,
        describe: c.describe,
        writesTo: c.table,
        selfOnly: !!c.selfOnly,
        fields: Object.entries(c.fields).map(([fk, f]) => ({
          key: fk, label: f.label, hint: f.hint, writesTo: `${c.table}.${f.column}`,
        })),
      };
    }),
    absent: ABSENT_CATEGORIES,
  };
}

module.exports = { CATEGORIES, CATEGORY_KEYS, ABSENT_CATEGORIES, getCategory, getField, targetOf, describe };
