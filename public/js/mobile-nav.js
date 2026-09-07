/* ═══════════════════════════════════════════════════════════════════════════
   M-EasyTools AI+ — OFF-CANVAS NAV
   ═══════════════════════════════════════════════════════════════════════════

   Turns the always-visible desktop sidebar on app.html and gao.html into a
   drawer at <=768px. Pairs with section 1 of css/tools-mobile.css.

   It builds its own toggle and scrim rather than expecting markup, because the
   two pages it serves are 4,044 and 1,964 lines and adding the same three
   elements to both by hand is two places to drift. The CSS is gated on the
   `.mnav-ready` class set below, so if this file 404s the sidebar keeps its
   current always-visible layout instead of being hidden with nothing to open
   it. A drawer with no opener is not a degraded nav, it is no nav.

   Safe to include on a page with no sidebar: it finds nothing and returns.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var BREAKPOINT = 768;   // must match css/tools-mobile.css
  var root = document.documentElement;

  function init() {
    // The two shells this serves. api-docs.html also has a `.sidebar`, but its
    // own `@media (max-width:860px)` already stacks it into the document flow —
    // it needs min-width:0, not a drawer — so it is matched by parent, never by
    // class alone.
    var sidebar = document.querySelector('.app-shell > .app-sidebar, .shell > .sidebar');
    if (!sidebar) return;

    var topbar = document.querySelector('.app-topbar, .topbar');
    if (!topbar) return;

    if (!sidebar.id) sidebar.id = 'mnav-sidebar';

    // ── toggle ──────────────────────────────────────────────────────────────
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mnav-toggle';
    toggle.setAttribute('aria-label', 'Open navigation menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', sidebar.id);
    toggle.innerHTML =
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" aria-hidden="true">' +
      '<path d="M3 5h14M3 10h14M3 15h14"/></svg>';
    topbar.insertBefore(toggle, topbar.firstChild);

    // ── scrim ───────────────────────────────────────────────────────────────
    // A real element and not a ::before, because it has to take the tap that
    // closes the drawer.
    var scrim = document.createElement('div');
    scrim.className = 'mnav-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    document.body.appendChild(scrim);

    var lastFocus = null;

    function isMobile() {
      return window.matchMedia('(max-width: ' + BREAKPOINT + 'px)').matches;
    }

    // Focus the drawer's first item once it has actually arrived on screen.
    // Whichever of the two triggers fires first wins; the other is disarmed.
    function focusFirst() {
      var done = false;
      var land = function () {
        if (done) return;
        done = true;
        sidebar.removeEventListener('transitionend', land);
        clearTimeout(timer);
        if (!root.classList.contains('mnav-open')) return;   // closed again already
        var first = sidebar.querySelector(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (first) first.focus();
      };
      var timer = setTimeout(land, 300);   // > the .24s transition in the CSS
      sidebar.addEventListener('transitionend', land);
    }

    function open() {
      lastFocus = document.activeElement;
      root.classList.add('mnav-open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close navigation menu');
      // Move focus into the drawer so a keyboard or switch user is not left
      // tabbing the page behind it.
      //
      // Not synchronously, and not on the next animation frame either. The
      // drawer is visibility:hidden while closed, .focus() on a hidden element
      // is a silent no-op, and neither adding the class nor forcing a reflow
      // nor requestAnimationFrame makes the focus land — measured, all three
      // leave document.activeElement on <body>. It only takes once the opening
      // transition has finished. So wait for that, with a timer as the fallback
      // for the reduced-motion case where the transition is 0s and may never
      // fire an event at all.
      focusFirst();
    }

    function close(restoreFocus) {
      if (!root.classList.contains('mnav-open')) return;
      root.classList.remove('mnav-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation menu');
      // Only pull focus back for a deliberate dismissal. On navigation the
      // destination decides where focus goes.
      if (restoreFocus !== false) {
        (lastFocus && document.contains(lastFocus) ? lastFocus : toggle).focus();
      }
      lastFocus = null;
    }

    toggle.addEventListener('click', function () {
      if (root.classList.contains('mnav-open')) close(); else open();
    });

    scrim.addEventListener('click', function () { close(); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && root.classList.contains('mnav-open')) {
        e.stopPropagation();
        close();
      }
    });

    // Tapping any nav item closes the drawer. Delegated on the sidebar so it
    // covers items rendered later, and so app.html's goTo() — which swaps
    // .page visibility in place without a navigation — still dismisses it.
    sidebar.addEventListener('click', function (e) {
      if (!root.classList.contains('mnav-open')) return;
      if (e.target.closest('.sidebar-item, .sb-item, a[href], .bottom-nav-item')) {
        close(false);
      }
    });

    // Trap Tab inside the drawer while it is open. Without this, Tab walks out
    // of the drawer and into a page the user cannot see.
    sidebar.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !root.classList.contains('mnav-open')) return;
      var items = Array.prototype.filter.call(
        sidebar.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        function (el) { return el.offsetParent !== null || el === document.activeElement; }
      );
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // Rotating to landscape can cross the breakpoint with the drawer open; the
    // CSS would put the sidebar back in flow while `.mnav-open` still claimed
    // body{overflow:hidden}, leaving a desktop layout that cannot scroll.
    var mq = window.matchMedia('(max-width: ' + BREAKPOINT + 'px)');
    var onChange = function () { if (!isMobile()) close(false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);

    // Last: the CSS only takes effect once this class lands, so setting it here
    // means the drawer layout never appears without the code that drives it.
    root.classList.add('mnav-ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
