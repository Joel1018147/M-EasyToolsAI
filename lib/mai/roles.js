'use strict';
// The roles M-Ai recognises on M-EasyTools, read out of THIS platform's real
// schema. Nothing here is carried over from a sibling platform's vocabulary,
// because a role no row in this database can hold is a permission that can
// never be granted and never be revoked.
//
// ── What server.js initDB() actually declares ──────────────────────────────
//   • users.role        VARCHAR(20) DEFAULT 'user'    (server.js:75)
//   • team_members.role VARCHAR(20) DEFAULT 'member'  (server.js:104)
//
// ── Every value users.role can actually hold, and who writes it ────────────
//   'user'   the COLUMN DEFAULT. Every self-registered account — email/password
//            (server.js:462) and Google OAuth (server.js:291) — lands here.
//   'admin'  the first account only (server.js:254 promotes MIN(id)), plus any
//            account the seller panel promotes (server.js:1376).
//   'owner'  written when an account creates a team (server.js:1175, which sets
//            users.role='owner' alongside team_members.role='owner').
//
// team_members.role holds 'owner' (server.js:1176) and 'member' (the invite
// default, server.js:1194). It is a DIFFERENT COLUMN and M-Ai never reads it:
// identity here comes from `req.user`, which is a `users` row, so `role` means
// `users.role` and nothing else. Nothing in this repository copies
// team_members.role back into users.role — an invited team member keeps
// users.role = 'user' — so 'member' never arrives at M-Ai from a session and is
// deliberately NOT a staff role below. Naming it as one would grant a
// permission on a value the identity column cannot carry.
//
// ── 'user' IS THE CUSTOMER SESSION, AND THAT IS WHY THIS IS HARDER HERE ────
// M-EasyDo's customer surfaces are ANONYMOUS: a customer carries no session,
// no user row and no role, so "a customer session" and "a caller with no role"
// are the same thing there, and a guard that refuses null closes the boundary.
//
// HERE THEY ARE AUTHENTICATED. `POST /api/chat` and `POST /api/generate` are
// guarded by requireApiKey (server.js:397), which resolves a real `users` row
// out of `users.api_key` and sets `req.user`. An external integration holding
// an API key therefore arrives as A REAL ROW WITH role='user'. A role check
// that only refused a blank would pass on M-EasyDo and FAIL OPEN here.
//
// So 'user' is not merely "not staff". It is the exact value the customer-
// facing surface carries, and isStaffRole('user') must be false for the same
// reason isStaffRole(null) must be.
//
// ── There is no CUSTOMER constant, on purpose ─────────────────────────────
// You cannot name what does not exist. NON_STAFF_ROLES below is exported for
// the boundary test to enumerate and for the registry builder to reject, and
// it is deliberately NOT a role set anything can put in `requiredRoles`:
// createMaiRegistry() checks membership of ALL_ROLES, which these are not in.

/** The platform operator's account. server.js promotes MIN(id) and the seller
 *  panel can set it. */
const ADMIN = 'admin';

/** A workspace owner — an account that created a team (server.js:1175).
 *
 *  READ THIS BEFORE ADDING A TOOL THAT IS NOT OWNER-SCOPED. Any authenticated
 *  account can reach 'owner' by calling POST /api/teams, so this role is
 *  SELF-ASSIGNABLE. That is acceptable — and only acceptable — because every
 *  tool granted to OWNER is scoped in its own SQL to `ctx.ownerId`, which
 *  routes/mai.js derives from the session's own `req.user.id`. Reaching
 *  'owner' therefore grants an account access to its OWN rows and to nothing
 *  else; it crosses no tenant boundary.
 *
 *  A tool that reads a table with no tenant column, or that reads across
 *  accounts, must be ADMIN_ONLY. lib/mai/tools/index.js asserts this at build
 *  time for the two global tables this platform has. */
const OWNER = 'owner';

/** Every role a staff caller can legitimately hold on M-EasyTools. */
const ALL_ROLES = [ADMIN, OWNER];

/**
 * The values users.role and team_members.role can hold that are NOT staff.
 * Exported so the boundary test can enumerate them and assert each reaches
 * zero tools, rather than asserting that against a list it invented itself.
 *
 * 'user'   — the users.role default; every self-registered account and every
 *            /api/chat + /api/generate API-key holder.
 * 'member' — the team_members.role default. Never copied into users.role, so
 *            it cannot arrive from a session; listed because the column exists.
 */
const NON_STAFF_ROLES = ['user', 'member'];

// ── Named sets, used as `requiredRoles` on every tool ───────────────────────
// Flat membership, no hierarchy. An implicit ladder ("admin outranks owner")
// reads well and hides its mistakes: you cannot grep for who reaches a tool,
// you have to evaluate the ladder. ADMIN is written out on every set.

/** Both staff roles. The default for owner-scoped reads and owner-scoped
 *  writes — every one of which carries `AND user_id = $n` in its own SQL. */
const STAFF = [ADMIN, OWNER];

/**
 * Admin only. Used for the two reads that CANNOT be owner-scoped because the
 * table carries no tenant column at all: `media_outlets` / `journalists` (the
 * shared Modus media directory, seeded in server.js initDB) and
 * `platform_modules` (the deployment's module switchboard). Neither discloses
 * another account's data — they are the same rows for everybody — but a read
 * that cannot be scoped is not a read a self-assignable role should reach.
 */
const ADMIN_ONLY = [ADMIN];

/**
 * Normalise a role at the boundary where a request enters M-Ai. Never applied
 * to stored data.
 *
 * Anything unrecognised resolves to NULL, not to a default role. 'user',
 * 'member', a typo, 'customer', 'guest', an empty string, whitespace, a
 * number, an object, an array — all reach nothing, rather than quietly
 * inheriting the weakest set that happens to grant something. Fail closed is
 * the whole contract of this function; there is no branch in it that produces
 * a role the caller did not already have.
 *
 * ── IT TRIMS, AND IT DELIBERATELY DOES NOT LOWERCASE ──────────────────────
 * M-EasyDo's equivalent lowercases. This one does not, and the difference is
 * deliberate: every value this repository ever writes into `users.role` is a
 * lowercase literal ('user' at signup, 'admin' at server.js:254 and :1376,
 * 'owner' at server.js:1175), so a row holding 'ADMIN' is a row this
 * application did not write. Case-folding it would GRANT PRIVILEGE on a value
 * nothing in the codebase produces, which is precisely the shape of an
 * accident. Refusing it is fail-closed AND visible — the account is told in
 * words that it carries no recognised staff role, so a genuine mis-cased row
 * gets found and fixed rather than silently working.
 *
 * The trim stays, because trimming TIGHTENS: it turns a whitespace-only role
 * into a rejection rather than a comparison. registry.canAccess() then matches
 * the result EXACTLY, without trimming, so ' admin ' cannot reach a tool by any
 * route that skips this function.
 *
 * NOTE also the deliberate difference from server.js's `req.user.role ||
 * 'admin'` pattern: defaulting an ABSENT role to the highest privilege is
 * survivable when you are reading your own profile and is not survivable for a
 * tool that can change a press release's status.
 */
function normaliseRole(role) {
  if (typeof role !== 'string') return null;
  const r = role.trim();
  if (!r) return null;
  return ALL_ROLES.includes(r) ? r : null;
}

/** True only for a recognised staff role. Everything else — including null,
 *  undefined, '', '   ', 'user', 'member', 'customer', 'anonymous', 'guest',
 *  'User', 'ADMIN', 0, false, {}, [] — is false. */
function isStaffRole(role) {
  return normaliseRole(role) !== null;
}

module.exports = {
  ADMIN, OWNER, ALL_ROLES, NON_STAFF_ROLES, STAFF, ADMIN_ONLY,
  normaliseRole, isStaffRole,
};
