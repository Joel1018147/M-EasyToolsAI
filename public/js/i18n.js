/**
 * M-EasyTools AI+ — i18n Engine
 * Supports: en (English), zh (Simplified Chinese), ms (Bahasa Malaysia)
 * Features: lazy-loading, localStorage persistence, browser language detection, no-reload switching
 */
(function () {
  'use strict';

  var SUPPORTED = ['en', 'zh', 'ms'];
  var DEFAULT_LANG = 'en';
  var LS_KEY = 'msm_lang';
  var LANG_LABELS = { en: 'EN', zh: '中文', ms: 'BM' };
  var LANG_HTML_ATTRS = { en: 'en', zh: 'zh-Hans', ms: 'ms' };

  var currentLang = DEFAULT_LANG;
  var cache = {};

  /* ── Language Detection ─────────────────────────── */
  function detectLang() {
    // 1. URL parameter (highest priority — for SEO alternate links)
    try {
      var urlLang = new URLSearchParams(window.location.search).get('lang');
      if (urlLang && SUPPORTED.indexOf(urlLang) !== -1) {
        localStorage.setItem(LS_KEY, urlLang);
        return urlLang;
      }
    } catch (e) {}

    // 2. localStorage (user saved preference)
    try {
      var saved = localStorage.getItem(LS_KEY);
      if (saved && SUPPORTED.indexOf(saved) !== -1) return saved;
    } catch (e) {}

    // 3. Browser language
    var browser = ((navigator.language || navigator.userLanguage || '')).toLowerCase();
    if (browser.startsWith('zh')) return 'zh';
    if (browser.startsWith('ms') || browser === 'id') return 'ms';
    return DEFAULT_LANG;
  }

  /* ── Translation Loader ─────────────────────────── */
  function loadTranslations(lang) {
    if (cache[lang]) return Promise.resolve(cache[lang]);

    // Reuse early fetch started in <head> if available
    var earlyFetch = (lang !== DEFAULT_LANG && window._i18nFetch) ? window._i18nFetch : null;
    window._i18nFetch = null;

    var fetchPromise = earlyFetch || fetch('/locales/' + lang + '.json');
    return fetchPromise
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        cache[lang] = data;
        return data;
      })
      .catch(function (err) {
        console.warn('[i18n] Failed to load translations for "' + lang + '":', err);
        return null;
      });
  }

  /* ── Deep Key Lookup ────────────────────────────── */
  function get(obj, path) {
    var parts = path.split('.');
    var val = obj;
    for (var i = 0; i < parts.length; i++) {
      if (val == null || typeof val !== 'object') return null;
      val = val[parts[i]];
    }
    return (val != null && typeof val !== 'object') ? String(val) : null;
  }

  /* ── DOM Translation ────────────────────────────── */
  function applyTranslations(translations) {
    // Text content
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var val = get(translations, el.getAttribute('data-i18n'));
      if (val != null) el.textContent = val;
    });

    // Inner HTML (for elements with embedded markup — translations are authored, not user-supplied)
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var val = get(translations, el.getAttribute('data-i18n-html'));
      if (val != null) el.innerHTML = val;
    });

    // Input placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var val = get(translations, el.getAttribute('data-i18n-placeholder'));
      if (val != null) el.setAttribute('placeholder', val);
    });

    // aria-label
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      var val = get(translations, el.getAttribute('data-i18n-aria'));
      if (val != null) el.setAttribute('aria-label', val);
    });

    // Document title
    var title = get(translations, 'meta.title');
    if (title) document.title = title;

    // Meta description
    var metaDesc = document.querySelector('meta[name="description"]');
    var desc = get(translations, 'meta.description');
    if (metaDesc && desc) metaDesc.setAttribute('content', desc);

    // OG locale
    var ogLocale = document.querySelector('meta[property="og:locale"]');
    var locale = get(translations, 'meta.og_locale');
    if (ogLocale && locale) ogLocale.setAttribute('content', locale);

    // OG title
    var ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && title) ogTitle.setAttribute('content', title);

    // OG description
    var ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc && desc) ogDesc.setAttribute('content', desc);
  }

  /* ── Switcher UI Update ─────────────────────────── */
  function updateSwitcherUI(lang) {
    // Update active option styling and aria-selected
    document.querySelectorAll('.lang-option').forEach(function (btn) {
      var isActive = btn.getAttribute('data-lang') === lang;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    // Update button label
    var label = document.getElementById('lang-current');
    if (label) label.textContent = LANG_LABELS[lang] || lang.toUpperCase();

    // Update html[lang]
    document.documentElement.lang = LANG_HTML_ATTRS[lang] || lang;
  }

  /* ── Set Language ───────────────────────────────── */
  function setLang(lang, save) {
    if (SUPPORTED.indexOf(lang) === -1) return Promise.resolve();
    if (save !== false) {
      try { localStorage.setItem(LS_KEY, lang); } catch (e) {}
    }
    currentLang = lang;
    updateSwitcherUI(lang);
    return loadTranslations(lang).then(function (translations) {
      if (translations) applyTranslations(translations);
    });
  }

  /* ── Dropdown Logic ─────────────────────────────── */
  function openDropdown() {
    var dd = document.getElementById('lang-dropdown');
    var btn = document.getElementById('lang-btn');
    if (!dd) return;
    dd.classList.add('open');
    btn && btn.setAttribute('aria-expanded', 'true');
    // Focus first option
    var first = dd.querySelector('.lang-option');
    if (first) first.focus();
  }

  function closeDropdown() {
    var dd = document.getElementById('lang-dropdown');
    var btn = document.getElementById('lang-btn');
    if (!dd) return;
    dd.classList.remove('open');
    btn && btn.setAttribute('aria-expanded', 'false');
  }

  function toggleDropdown() {
    var dd = document.getElementById('lang-dropdown');
    if (!dd) return;
    dd.classList.contains('open') ? closeDropdown() : openDropdown();
  }

  /* ── Init ───────────────────────────────────────── */
  function init() {
    var btn = document.getElementById('lang-btn');
    var dd = document.getElementById('lang-dropdown');

    if (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleDropdown();
      });

      btn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDropdown(); }
        if (e.key === 'Escape') closeDropdown();
        if (e.key === 'ArrowDown') { e.preventDefault(); openDropdown(); }
      });
    }

    if (dd) {
      dd.addEventListener('keydown', function (e) {
        var opts = Array.from(dd.querySelectorAll('.lang-option'));
        var idx = opts.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); opts[(idx + 1) % opts.length].focus(); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); opts[(idx - 1 + opts.length) % opts.length].focus(); }
        if (e.key === 'Escape')    { closeDropdown(); btn && btn.focus(); }
        if (e.key === 'Tab')       { closeDropdown(); }
      });
    }

    document.querySelectorAll('.lang-option').forEach(function (opt) {
      opt.addEventListener('click', function () {
        setLang(opt.getAttribute('data-lang'));
        closeDropdown();
        btn && btn.focus();
      });
    });

    // Close on outside click
    document.addEventListener('click', function () { closeDropdown(); });

    // Detect and apply language
    var lang = detectLang();
    return setLang(lang, false);
  }

  /* ── Public API ─────────────────────────────────── */
  window.I18n = {
    init: init,
    setLang: setLang,
    getLang: function () { return currentLang; }
  };

  // Auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
