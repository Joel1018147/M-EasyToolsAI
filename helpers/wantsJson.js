/* ═══════════════════════════════════════════════════════════════════════════
   wantsJson — Modus UI Contract §4.3e, ONE definition
   ───────────────────────────────────────────────────────────────────────────
   "Is the thing on the other end of this request a page navigation, or a
   fetch()?" There is exactly one answer to that question in this repo and it
   lives here.

   It used to live in two places with two different answers. server.js was
   fixed in 7732d91; middleware/checkSub.js still asked `req.accepts('json')`,
   which is the precise anti-pattern the contract names:

     A browser sends  Accept: text/html,application/xhtml+xml,…,<wildcard>;q=0.8
     The wildcard matches, so req.accepts('json') returns 'json' FOR AN
     ORDINARY PAGE NAVIGATION.

     (<wildcard> is written out rather than typed literally: the asterisk-slash
      in it closes a block comment, which is how the first version of this file
      failed to parse at all.)

   The consequence in checkSub was live: a signed-in user whose subscription
   had lapsed, clicking a link to /seo, was answered with a raw JSON 402 body
   instead of being sent to /billing. They were logged in, the page was blank
   JSON, and there was nothing on screen telling them to renew.

   Fixing one copy and leaving the other is how the ecosystem got here. This
   module exists so there is nothing left to fix twice.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/**
 * The /api/ path prefix is the PRIMARY signal, because fetch() sends the
 * wildcard Accept header by default and content negotiation alone
 * misclassifies most API calls.
 *
 * req.originalUrl is checked first and req.path second: inside a router mounted
 * at /api the prefix is stripped from req.path, so a req.path-only check
 * silently stops firing the moment someone re-mounts a router. Checking both
 * makes the guard a property of the request rather than of the wiring.
 *
 * req.accepts(['html','json']) asks which the client PREFERS, so text/html
 * wins when a request advertises both and clicking a link still redirects.
 */
function wantsJson(req) {
  if (req.originalUrl && req.originalUrl.startsWith('/api/')) return true;
  if (req.path && req.path.startsWith('/api/')) return true;
  if (req.xhr) return true;
  return req.accepts(['html', 'json']) === 'json';
}

module.exports = { wantsJson };
