'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   PRIVATE PREVIEW — the product pages are public, the app is not.
   ───────────────────────────────────────────────────────────────────────────
   BYTE-IDENTICAL IN ALL SEVEN M-EASY REPOS (M-EasyDo, M-EasyTools,
   M-EasyCommerce, M-EasyHalal, M-EasySchool, M-EasyPOS, ESG Super App). If you
   change it here, change it in all seven. A guard that has drifted between
   repos is a guard nobody can reason about, and this one decides who gets into
   a production system.

   ── WHAT IT IS FOR ────────────────────────────────────────────────────────
   Every platform's landing page and its /modules/… product pages are linked
   publicly. Anyone may read them. Nobody may get past the sign-in form except
   the addresses on the allowlist.

   ── ONE PREDICATE, NOT TWO ────────────────────────────────────────────────
   `allows(email)` decides BOTH sign-in and registration. It would have been
   easy to write "registration is refused for everyone, sign-in is checked
   against a list" — two rules, and the second one quietly stops covering the
   first the moment someone adds a passwordless path. One predicate at three
   layers is the whole design:

     1 · REGISTRATION   the address must be allowed, or no account is created
     2 · SIGN-IN        the address must be allowed, or no session is issued
     3 · EVERY REQUEST  a session whose user is no longer allowed is destroyed

   Layer 3 is why this is not a game of whack-a-mole. It is the backstop for
   sessions that predate the lock, for OAuth callbacks, and for any credential
   path a later change adds without reading this file. An auth route that
   forgets to call layers 1 and 2 still cannot produce a usable session.

   ── IT FAILS CLOSED, AND IT CANNOT LOCK ITS OWNER OUT ─────────────────────
   Two decisions that pull in opposite directions, and both matter:

     ABSENT CONFIG MEANS LOCKED. `PREVIEW_LOCK` has to say "off" to be off. A
     platform that loses its environment on a redeploy comes back locked, not
     open — the failure mode of this guard is "the owner has to set a variable
     again", never "the app was public for a day and nobody noticed".

     THE CODE ALLOWLIST CANNOT BE EMPTIED BY CONFIG. `PREVIEW_ALLOW_EMAILS`
     ADDS to the list below, it never replaces it. A typo'd or deleted variable
     therefore cannot lock the owner out of seven production systems at once,
     which is the one irreversible outcome available here. These addresses are
     not secret — an allowlist is not a credential, and a password is still
     required.

   ── ENVIRONMENT ───────────────────────────────────────────────────────────
     PREVIEW_LOCK           'off' lifts the lock. Anything else, including
                            absent, keeps it on.
     PREVIEW_ALLOW_EMAILS   comma-separated extra addresses. Added to the list
                            below, never substituted for it. Put the demo
                            workspace's own login here if you seed one — the
                            seed script registers through the public route and
                            is refused like anyone else otherwise.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Addresses that can always get in, whatever the environment says.
 *  Not a secret: this decides WHO MAY TRY, not whether the password is right. */
const CODE_ALLOWLIST = [
  'joel31255@gmail.com',
];

/** What a refused visitor is told. One sentence about the state of the
 *  product, one route to a human. It never says whether the address exists,
 *  and it never says the credentials were wrong — neither is why they failed. */
const MESSAGE =
  'This platform is in private preview. The product pages are open to everyone; '
  + 'signing in is limited to the Modus AI Associates team. '
  + 'To arrange a walkthrough, contact us on +60 11-1146 9065.';

function normalise(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

/** The effective allowlist: the code list plus anything the environment adds. */
function allowlist() {
  const extra = String(process.env.PREVIEW_ALLOW_EMAILS || '')
    .split(',')
    .map(normalise)
    .filter(Boolean);
  return Array.from(new Set(CODE_ALLOWLIST.map(normalise).concat(extra)));
}

/** Absent, blank or any value other than 'off' means the lock is ON. */
function isLocked() {
  return normalise(process.env.PREVIEW_LOCK) !== 'off';
}

/** May this address sign in or register? The one predicate. */
function allows(email) {
  if (!isLocked()) return true;
  const e = normalise(email);
  return e !== '' && allowlist().indexOf(e) !== -1;
}

/** Layer 3. A session object, whatever shape the repo's user rows have.
 *  A user with no readable address is refused: an unidentifiable session is
 *  exactly the thing this guard exists to stop, so it is not given the
 *  benefit of the doubt. */
function allowsUser(user) {
  if (!isLocked()) return true;
  if (!user) return false;
  return allows(user.email || user.user_email || user.username);
}

/* ── Express helpers ───────────────────────────────────────────────────────
   Kept here rather than in each repo's routes so that the STATUS and the
   WORDING are the same everywhere. 403, not 401: 401 invites the browser to
   re-prompt for credentials that were never the problem. */

/** True when the caller wants JSON rather than a page. The Accept test
 *  excludes text/html deliberately: a browser navigation sends
 *  "text/html,…,application/json;q=0.9" and must get the page, not a body it
 *  will render as source. */
function wantsJson(req) {
  const url = String(req.originalUrl || req.url || '');
  if (/(^|\/)api\//.test(url)) return true;
  if (req.xhr === true) return true;
  const accept = String((req.headers && req.headers.accept) || '');
  return /json/i.test(accept) && !/text\/html/i.test(accept);
}

/** Refuse one request. JSON for a fetch; for a navigation, a page that SAYS SO.
 *
 *  It was a redirect to the landing first, and that was wrong twice over.
 *  `res.status(403).redirect(…)` sends 302 — Express's redirect overwrites the
 *  status, so the "403" was decorative. And a silent bounce back to the page
 *  they came from reads as a broken form: the visitor tries again, harder. A
 *  refusal a person can read is the whole point of having a message. */
function refuse(req, res) {
  if (wantsJson(req)) return res.status(403).json({ error: MESSAGE, preview: true });
  const body = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>Private preview</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;'
    + 'justify-content:center;background:#0b1020;color:#e8edf7;'
    + 'font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}'
    + 'main{max-width:34rem}h1{font-size:1.35rem;margin:0 0 .75rem}'
    + 'p{margin:0 0 1.25rem;color:#9fb0cc}a{color:#7fb0ff}</style></head><body><main>'
    + '<h1>Private preview</h1><p>' + MESSAGE + '</p>'
    + '<p><a href="/">Back to the product pages</a></p>'
    + '</main></body></html>';
  // .send() with a string sets text/html itself. Not .type('html') — that
  // is one more method a caller's response object has to implement, and the
  // repos' own auth harnesses pass a minimal double.
  return res.status(403).send(body);
}

/** Layers 1 and 2, as middleware. Reads the address from the request body,
 *  which is where every credentialed POST in these repos carries it. */
function guardCredentials(req, res, next) {
  if (!isLocked()) return next();
  const body = req.body || {};
  if (allows(body.email || body.username)) return next();
  return refuse(req, res);
}

/** Layer 3, as middleware. Mount inside each repo's requireAuth, after it has
 *  established req.user. Destroys the session rather than only refusing, so a
 *  visitor who was signed in before the lock does not keep bouncing. */
function guardSession(req, res, next) {
  if (allowsUser(req.user)) return next();

  const done = function () { return refuse(req, res); };
  const drop = function () {
    if (req.session && req.session.destroy) return req.session.destroy(done);
    return done();
  };

  /* passport ≥0.6 requires a callback and throws without one; ≤0.5 takes none.
     ARITY is the version test, so there is nothing here to catch — and there
     must not be: a swallowed error would mean the session survived while this
     function reported that it had not (RULE 6). If req.logout throws, it is a
     real failure and it should be loud. */
  if (typeof req.logout !== 'function') return drop();
  if (req.logout.length > 0) return req.logout(drop);
  req.logout();
  return drop();
}

module.exports = {
  MESSAGE,
  CODE_ALLOWLIST,
  normalise,
  allowlist,
  isLocked,
  allows,
  allowsUser,
  wantsJson,
  refuse,
  guardCredentials,
  guardSession,
};
