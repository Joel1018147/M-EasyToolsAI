/* ═══════════════════════════════════════════════════════════════════════════
   PRIVATE PREVIEW — the landing page's sign-in affordances, told the truth.
   ───────────────────────────────────────────────────────────────────────────
   BYTE-IDENTICAL IN ALL SEVEN M-EASY REPOS, served at /js/preview-cta.js.

   The server already refuses: previewLock.js turns away every address that is
   not on the allowlist, at three layers. This file is not the enforcement and
   must never be mistaken for it — deleting it changes nothing about who can
   sign in. What it changes is whether the page LIES.

   A landing page carrying five "Start for Free" buttons that all end in a
   refusal is a worse product than one that says what it is. §4.2's rule, which
   this ecosystem applies to empty states, applies just as well to a control
   that cannot do the thing it names.

   ── WHY IT ASKS THE SERVER ────────────────────────────────────────────────
   The lock is an environment variable, so the page cannot know its state by
   itself. It asks /preview-state, and it only rewrites anything if the answer
   is an explicit `locked: true`. Every other outcome — the endpoint missing,
   the network failing, JSON that does not parse — leaves the buttons exactly
   as authored. A marketing page that quietly turned into "Request a demo"
   because a fetch timed out would be the worse failure.

   ── WHAT IT REWRITES ──────────────────────────────────────────────────────
   Any link into the sign-in or registration flow, wherever it sits — nav,
   hero, footer, mid-page bands. Matching on the href rather than a list of
   classes is deliberate: a CTA added to one of these pages next month is
   covered without anyone remembering this file exists.

   The pages are trilingual and the i18n engine rewrites text on language
   change, so the data-i18n hook is REMOVED from anything rewritten here —
   otherwise switching to Malay would put "Start for Free" back.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CONTACT = 'https://wa.me/601111469065';
  var LABEL = 'Request a demo';

  /* Hrefs that lead into the app's front door. Prefix-matched, so
     /auth/login?next=… and /login#register are both caught. */
  var ENTRY = ['/login', '/register', '/signup', '/auth/login', '/auth/register', '/auth/signup'];

  function isEntry(href) {
    if (!href) return false;
    var path = href.split('?')[0].split('#')[0];
    for (var i = 0; i < ENTRY.length; i++) if (path === ENTRY[i]) return true;
    return false;
  }

  function rewrite() {
    var links = document.querySelectorAll('a[href]');
    var n = 0;
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (!isEntry(a.getAttribute('href'))) continue;

      a.setAttribute('href', CONTACT);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');

      /* An onclick written for the old destination (M-EasyTools routes its
         CTAs through goToApp) would fight the new one. */
      a.removeAttribute('onclick');
      a.onclick = null;

      /* Replace the label without touching the element's structure: some of
         these carry an icon span alongside the text. */
      var labelled = a.querySelector('[data-i18n]') || a;
      labelled.removeAttribute('data-i18n');
      a.removeAttribute('data-i18n');
      if (a.childElementCount === 0) {
        a.textContent = LABEL;
      } else {
        for (var k = 0; k < a.childNodes.length; k++) {
          var node = a.childNodes[k];
          if (node.nodeType === 3 && node.nodeValue.trim()) { node.nodeValue = LABEL; break; }
          if (node.nodeType === 1 && node.textContent.trim()) {
            node.removeAttribute('data-i18n');
            node.textContent = LABEL;
            break;
          }
        }
      }
      n++;
    }
    return n;
  }

  function start() {
    fetch('/preview-state', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (state) {
        if (!state || state.locked !== true) return;   // only an explicit yes
        rewrite();
        /* The i18n engines on these pages re-apply their dictionary when the
           language changes, which would undo the labels. Re-running after any
           such change is cheaper than integrating with six different engines. */
        document.addEventListener('click', function (e) {
          if (e.target && e.target.closest && e.target.closest('[data-lang], .lang-switch, .lang-btn, #lp-lang')) {
            setTimeout(rewrite, 60);
          }
        }, true);
      })
      .catch(function (err) {
        /* NOT a fallback, and not a swallow either (RULE 6). This file only
           ever SUBTRACTS from a page that is already correct, so the right
           behaviour when it cannot reach the server is to change nothing. But
           silence and a bug look identical from the outside, so it says which
           one this is, where a developer will see it. */
        if (window.console && window.console.warn) {
          window.console.warn('preview-cta: /preview-state unreachable — '
            + 'leaving the sign-in buttons exactly as authored.', err);
        }
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
