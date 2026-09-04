/* ═══════════════════════════════════════════════════════════════════════════
   SUBSCRIPTION ENFORCEMENT — one switch, one reader
   ───────────────────────────────────────────────────────────────────────────
   Joel's call, 2026-09-04: no subscription for now — every signed-in account
   gets every feature, image generation especially. This file is the whole of
   that decision: ONE definition of the question, the way `helpers/wantsJson.js`
   is one definition of "page or fetch?". Callers import it; nobody re-derives
   it from `process.env` locally, which is how a switch ends up meaning two
   different things in two files.

   Anything holding a request should prefer `req.subscription` — `checkSub`
   asks this once per request and puts the answer there, so the page, the guard
   and the image cap cannot disagree about a single request. `isEnforced()` is
   for the callers that have no request to read, like an M-Ai tool executor,
   whose ctx is identity-only by design.

   WHY THE CODE DEFAULT IS *OFF*, WHICH IS THE UNUSUAL DIRECTION.
   The house style for a switch like this is fail-closed — `PREVIEW_LOCK`
   defaults to LOCKED and a Railway variable lifts it. This one is inverted on
   purpose, and the purpose is a specific incident:

     * The paywall failing OPEN costs money. Nothing else. Every route behind
       it is already behind `requireAuth`, so no data is exposed and this is a
       revenue question, not a security one — fail-closed is a rule about
       auth, webhook signatures and payment paths, not about a price.
     * The paywall failing CLOSED locked every account out of the product,
       including out of the page where they could have paid, for as long as
       nobody looked. That is Run 150: sixty `GET /billing 302` in one day, and
       four of five accounts inside the loop. It was silent.

   A variable can go missing — an environment rebuilt, a service cloned, a
   value cleared by accident. With the default in this direction, losing it
   means the product stays open, which is what it is today. With the default
   the other way, losing it would silently re-create the lockout, and the
   payment gateway it would send people to is not configured either
   (`IPAY88_MERCHANT_CODE` / `IPAY88_MERCHANT_KEY` are unset on production),
   so there would be no way out from the inside.

   Re-arm with ONE Railway variable, no code change:

       SUBSCRIPTION_ENFORCEMENT=on

   Anything not recognised as "on" leaves the product open, and the boot banner
   prints which mode is live, so a typo is visible rather than assumed.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const ENV_NAME = 'SUBSCRIPTION_ENFORCEMENT';

/** The values that turn the paywall back ON. Everything else leaves it off. */
const ENFORCING_VALUES = Object.freeze(['on', 'true', '1', 'yes', 'enforce', 'enforced']);

/**
 * The status `checkSub` reports when nothing is being enforced.
 *
 * It is a NEW value, deliberately — not 'active', which would claim a payment
 * that never happened, and not the row's own 'expired'/'trial', which would
 * make an open deployment indistinguishable from a locked one to everything
 * downstream. `lib/image/caps.js` maps it, `routes/subscription.js` reports
 * it, and `public/billing.html` says so on the page.
 */
const OPEN_STATUS = 'open';

/**
 * Read at CALL time, never at module load: a variable read once at require()
 * cannot be changed without a rebuild, and this one must be switchable by
 * setting a Railway variable and restarting.
 */
function isEnforced() {
  const raw = process.env[ENV_NAME];
  if (typeof raw !== 'string') return false;
  return ENFORCING_VALUES.includes(raw.trim().toLowerCase());
}

/**
 * The subscription object for a deployment that enforces nothing.
 *
 * `showBanner: false` matters as much as the status: `public/app.html` renders
 * the expiry banner from this field on every page, and a banner warning about
 * access nobody is going to lose is a lie the user cannot check.
 */
function openSubscription() {
  return {
    status: OPEN_STATUS,
    enforced: false,
    showBanner: false,
    bannerType: null,
    bannerMessage: null,
  };
}

/** One sentence, used anywhere a surface would otherwise report a lock. */
const OPEN_NOTICE =
  'Subscriptions are not being enforced on this deployment — every signed-in '
  + 'account has full access to every feature.';

module.exports = { ENV_NAME, OPEN_STATUS, OPEN_NOTICE, isEnforced, openSubscription };
