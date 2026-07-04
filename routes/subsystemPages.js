'use strict';
const express = require('express');
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Per-system landing pages for M-EasyTools — public marketing pages (no auth).
// Same design language as the main landing page (public/index.html):
// deep charcoal ground, orange accent, Libre Baskerville display + Plus Jakarta
// Sans body, animated hero, feature grid, "Open Tool" CTA into the module.
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEMS = [
  {
    slug: 'main', label: 'MAIN PLATFORM', icon: '🛠️', accent: [232,98,42],
    name: 'M-EasyTools AI+', appUrl: '/app',
    tagline: 'All-in-one AI marketing platform with 40+ tools, AI chat, bulk generation, a document manager and full dashboard — built for Malaysian businesses.',
    features: [
      { icon: '🧰', name: '40+ AI Tools', desc: 'Content, social, email, ads, SEO, commerce, and sales generators in one place.' },
      { icon: '💬', name: 'AI Chat Assistant', desc: 'Always-on marketing assistant for ideas and copy on demand.' },
      { icon: '⚡', name: 'Bulk Generation', desc: 'Generate many variants at once and export in seconds.' },
      { icon: '📄', name: 'Document Manager', desc: 'Every generated asset saved, scored, and searchable.' },
      { icon: '🔌', name: 'WordPress & Shopify', desc: 'Publish generated content straight to your site.' },
      { icon: '🔑', name: 'Developer API', desc: 'Programmatic access to every generator with your own API key.' },
    ]
  },
  {
    slug: 'content', label: 'CONTENT', icon: '✍️', accent: [232,98,42],
    name: 'M-EasyContent AI+ Tools', appUrl: '/content',
    tagline: 'Generate high-quality blog posts, articles, landing page copy and long-form content in seconds using AI — in English and Bahasa Malaysia.',
    features: [
      { icon: '📝', name: 'Blog & Articles', desc: 'Long-form, SEO-ready posts in seconds.' },
      { icon: '🏷️', name: 'Landing Page Copy', desc: 'Persuasive hero, features, and CTA copy.' },
      { icon: '🌐', name: 'Bilingual', desc: 'English and Bahasa Malaysia output.' },
      { icon: '📊', name: 'SEO Scoring', desc: 'Built-in readability and SEO grade on every draft.' },
      { icon: '🎯', name: 'Brand Tone', desc: 'Matches your saved brand voice.' },
      { icon: '💾', name: 'Auto-Save', desc: 'Every draft stored in your document manager.' },
    ]
  },
  {
    slug: 'social', label: 'SOCIAL', icon: '📱', accent: [236,72,153],
    name: 'M-EasySocial AI+ Tools', appUrl: '/social',
    tagline: 'Create scroll-stopping social media captions, hashtags, content calendars and viral post ideas for Facebook, Instagram, TikTok and LinkedIn.',
    features: [
      { icon: '✨', name: 'Captions & Hooks', desc: 'Scroll-stopping captions for every platform.' },
      { icon: '#️⃣', name: 'Hashtag Sets', desc: 'Relevant, reach-boosting hashtag groups.' },
      { icon: '🗓️', name: 'Content Calendars', desc: 'Plan weeks of posts in minutes.' },
      { icon: '🔥', name: 'Viral Ideas', desc: 'Trend-aware post concepts.' },
      { icon: '📱', name: 'Multi-Platform', desc: 'Facebook, Instagram, TikTok, and LinkedIn.' },
      { icon: '🎯', name: 'Brand Tone', desc: 'On-brand voice every time.' },
    ]
  },
  {
    slug: 'mail', label: 'EMAIL', icon: '📧', accent: [14,165,233],
    name: 'M-EasyMail AI+ Tools', appUrl: '/mail',
    tagline: 'Write high-converting email sequences, newsletters, subject lines and drip campaigns that get opened, read and clicked.',
    features: [
      { icon: '✉️', name: 'Email Sequences', desc: 'Multi-step nurture and sales flows.' },
      { icon: '📰', name: 'Newsletters', desc: 'Engaging newsletter copy on demand.' },
      { icon: '🎯', name: 'Subject Lines', desc: 'High open-rate subject line variants.' },
      { icon: '🔁', name: 'Drip Campaigns', desc: 'Automated series that convert.' },
      { icon: '🧪', name: 'A/B Variants', desc: 'Multiple versions to test.' },
      { icon: '💾', name: 'Auto-Save', desc: 'Stored in your document manager.' },
    ]
  },
  {
    slug: 'ads', label: 'ADS', icon: '📣', accent: [249,115,22],
    name: 'M-EasyAds AI+ Tools', appUrl: '/ads',
    tagline: 'Generate persuasive ad copy for Google Ads, Facebook Ads, TikTok Ads and display banners that drive clicks and conversions.',
    features: [
      { icon: '🔍', name: 'Google Ads', desc: 'Headlines and descriptions that rank and convert.' },
      { icon: '📘', name: 'Facebook Ads', desc: 'Primary text, headlines, and CTAs.' },
      { icon: '🎵', name: 'TikTok Ads', desc: 'Native-feeling short-form ad scripts.' },
      { icon: '🖼️', name: 'Display Banners', desc: 'Punchy, high-impact banner copy.' },
      { icon: '🧪', name: 'Variants', desc: 'Many angles to test fast.' },
      { icon: '🎯', name: 'Conversion-Focused', desc: 'Written to drive clicks and conversions.' },
    ]
  },
  {
    slug: 'seo', label: 'SEO', icon: '🔍', accent: [16,185,129],
    name: 'M-EasySEO AI+ Tools', appUrl: '/seo',
    tagline: 'Optimize your content for search engines with AI-powered meta tags, keyword suggestions, SEO audits and on-page optimization tools.',
    features: [
      { icon: '🏷️', name: 'Meta Tags', desc: 'Titles and descriptions optimised to rank.' },
      { icon: '🔑', name: 'Keyword Suggestions', desc: 'Relevant keywords and clusters.' },
      { icon: '🩺', name: 'SEO Audits', desc: 'On-page checks with actionable fixes.' },
      { icon: '📊', name: 'Content Scoring', desc: 'SEO and readability grades.' },
      { icon: '🔗', name: 'Internal Linking', desc: 'Suggestions to strengthen site structure.' },
      { icon: '📈', name: 'On-Page Optimisation', desc: 'Headings, density, and structure.' },
    ]
  },
  {
    slug: 'commerce', label: 'COMMERCE', icon: '🛍️', accent: [139,92,246],
    name: 'M-EasyCommerce AI+ Tools', appUrl: '/commerce',
    tagline: 'Create compelling product descriptions, Shopify listings, eCommerce copy and upsell scripts that turn browsers into buyers.',
    features: [
      { icon: '🛒', name: 'Product Descriptions', desc: 'Benefit-led copy that sells.' },
      { icon: '🏬', name: 'Shopify Listings', desc: 'Optimised titles and descriptions.' },
      { icon: '💬', name: 'Upsell Scripts', desc: 'Cross-sell and upsell copy.' },
      { icon: '🌟', name: 'Benefit Bullets', desc: 'Scannable feature-to-benefit lists.' },
      { icon: '🔍', name: 'SEO-Ready', desc: 'Search-friendly product copy.' },
      { icon: '🎯', name: 'Conversion-Focused', desc: 'Turns browsers into buyers.' },
    ]
  },
  {
    slug: 'sales', label: 'SALES', icon: '💼', accent: [245,158,11],
    name: 'M-EasySales AI+ Tools', appUrl: '/sales',
    tagline: 'Write powerful sales scripts, cold outreach emails, proposal copy and follow-up sequences that close more deals faster.',
    features: [
      { icon: '📞', name: 'Sales Scripts', desc: 'Call and pitch scripts that convert.' },
      { icon: '📧', name: 'Cold Outreach', desc: 'Personalised cold emails that get replies.' },
      { icon: '📄', name: 'Proposal Copy', desc: 'Persuasive proposals and one-pagers.' },
      { icon: '🔁', name: 'Follow-Up Sequences', desc: 'Multi-touch closing sequences.' },
      { icon: '🛡️', name: 'Objection Handling', desc: 'Ready responses to common objections.' },
      { icon: '⚡', name: 'Fast Drafts', desc: 'Deals move faster.' },
    ]
  },
  {
    slug: 'aichat', label: 'AI CHAT', icon: '💬', accent: [0,212,255],
    name: 'M-EasyTools AI+ System', appUrl: '/aichat',
    tagline: 'Your always-on AI marketing assistant — ask anything, generate content on demand, brainstorm ideas and get instant marketing advice 24/7.',
    features: [
      { icon: '💬', name: 'Always-On Assistant', desc: 'Ask anything, anytime.' },
      { icon: '⚡', name: 'On-Demand Content', desc: 'Generate copy within the chat.' },
      { icon: '💡', name: 'Brainstorming', desc: 'Ideas, angles, and campaign concepts.' },
      { icon: '📚', name: 'Marketing Advice', desc: 'Instant expert guidance.' },
      { icon: '🧠', name: 'Context-Aware', desc: 'Knows your brand voice.' },
      { icon: '🕐', name: '24/7', desc: 'Around the clock.' },
    ]
  },
  {
    slug: 'gao', label: 'GAO SUITE', icon: '🛰️', accent: [124,58,237],
    name: 'M-EasyGAO AI+ Suite', appUrl: '/gao',
    tagline: "Track your brand's visibility inside ChatGPT, Claude, Gemini, Perplexity and DeepSeek — monitor AI citations, analyze prompts, extract entities and outrank competitors in AI search.",
    features: [
      { icon: '🛰️', name: 'AI Visibility Tracking', desc: 'See where your brand appears across the major LLMs.' },
      { icon: '📊', name: 'Citation Monitoring', desc: 'Track ChatGPT, Claude, Gemini, Perplexity, and DeepSeek.' },
      { icon: '🔎', name: 'Prompt Analysis', desc: 'Understand the prompts that surface you.' },
      { icon: '🏷️', name: 'Entity Extraction', desc: 'Pull named entities from AI answers.' },
      { icon: '🥇', name: 'Competitor Outranking', desc: 'Beat rivals in AI search results.' },
      { icon: '🇲🇾', name: 'Built for SEA', desc: 'The only GAO suite for Malaysia and Southeast Asia.' },
    ]
  },
  {
    slug: 'pr', label: 'PR', icon: '📰', accent: [6,182,212],
    name: 'M-EasyPR AI+', appUrl: '/pr',
    tagline: 'Write professional press releases, distribute to Malaysian and Southeast Asian media outlets, and track publications and reach — Modus is the wire service.',
    features: [
      { icon: '✍️', name: 'AI Press Release Writer', desc: 'Newsworthy, SEO + GEO-optimised releases in the correct format.' },
      { icon: '📡', name: 'Media Distribution', desc: 'Blast releases to matched outlets and journalists.' },
      { icon: '🗞️', name: 'Malaysian & SEA Media DB', desc: 'Curated regional outlets and journalists by tier.' },
      { icon: '📊', name: 'Publication Reports', desc: 'Track where you were published and total reach.' },
      { icon: '🤖', name: 'GEO Scoring', desc: 'Likelihood of being cited in AI-generated answers.' },
      { icon: '📦', name: 'Tiered Packages', desc: 'Starter, Growth, and Enterprise reach.' },
    ]
  },
];

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function gradientName(name){return esc(name).replace(/(AI\+.*)$/, '<em>$1</em>');}

const HEAD_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">`;

const BASE_CSS = `
:root{--bg:#07090F;--bg2:#0D1018;--text:#F2F4F8;--muted:#8892A4;--muted2:#4A5568;--card:rgba(255,255,255,0.03);--border:rgba(255,255,255,0.06);--border2:rgba(255,255,255,0.1);--disp:'Libre Baskerville',Georgia,serif;--body:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:var(--body);background:var(--bg);color:var(--text);min-height:100vh;line-height:1.6;overflow-x:hidden}
body.dark-deeper{background:#040609}
a{color:inherit;text-decoration:none}
.nav{position:fixed;top:0;left:0;right:0;z-index:100;height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 48px;background:rgba(7,9,15,0.85);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
.nav-logo{display:flex;align-items:center;gap:12px;font-family:var(--disp);font-weight:700;font-size:16px;color:var(--text)}
.logo-dot{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#E8622A,#FF7A45);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#fff;flex-shrink:0}
.nav-links{display:flex;align-items:center;gap:30px}
.nav-links a{font-size:14px;font-family:var(--body);font-weight:500;color:var(--muted);transition:color .2s}
.nav-links a:hover{color:var(--text)}
.nav-right{display:flex;align-items:center;gap:14px}
.crumb{display:flex;align-items:center;gap:8px;font-size:13px;font-family:var(--body);font-weight:600;color:var(--muted)}
.crumb a:hover{color:var(--text)}
.crumb .sep{color:var(--muted2)}
.nav-cta{padding:9px 22px;background:rgb(var(--r),var(--g),var(--b));color:#fff;border-radius:9px;font-size:13px;font-family:var(--body);font-weight:700;transition:filter .2s;display:inline-block;cursor:pointer;border:none}
.nav-cta:hover{filter:brightness(1.1)}
.hero{min-height:100vh;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:150px 24px 90px}
.hero-glow{position:absolute;inset:0;background:radial-gradient(ellipse 70% 50% at 50% 0%,rgba(var(--r),var(--g),var(--b),.16) 0%,transparent 70%),radial-gradient(ellipse 50% 40% at 100% 100%,rgba(232,98,42,.06) 0%,transparent 60%);pointer-events:none}
.hero-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.015) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.015) 1px,transparent 1px);background-size:72px 72px;-webkit-mask-image:radial-gradient(ellipse at 50% 0%,rgba(0,0,0,.8) 0%,transparent 70%);mask-image:radial-gradient(ellipse at 50% 0%,rgba(0,0,0,.8) 0%,transparent 70%);pointer-events:none}
.hero-content{position:relative;z-index:1;text-align:center;max-width:880px;width:100%;margin:0 auto}
.hero-emblem{width:92px;height:92px;margin:0 auto 30px;border-radius:22px;background:linear-gradient(135deg,rgba(var(--r),var(--g),var(--b),.35),rgba(var(--r),var(--g),var(--b),.12));border:1px solid rgba(var(--r),var(--g),var(--b),.4);display:flex;align-items:center;justify-content:center;font-size:44px;line-height:1;box-shadow:0 12px 50px rgba(var(--r),var(--g),var(--b),.25)}
.badge-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 18px;background:rgba(var(--r),var(--g),var(--b),.1);border:1px solid rgba(var(--r),var(--g),var(--b),.3);border-radius:100px;font-size:12px;font-family:var(--body);font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgb(var(--r),var(--g),var(--b));margin-bottom:26px}
.badge-dot{width:7px;height:7px;border-radius:50%;background:rgb(var(--r),var(--g),var(--b));animation:pulse 2s ease-in-out infinite;flex-shrink:0}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}
.hero h1{font-family:var(--disp);font-weight:700;font-size:clamp(34px,5vw,64px);letter-spacing:-1px;line-height:1.1;margin-bottom:22px;text-wrap:balance}
.hero h1 em{font-style:italic;color:rgb(var(--r),var(--g),var(--b))}
.hero-sub{font-size:clamp(16px,1.7vw,20px);color:var(--muted);max-width:620px;margin:0 auto 44px;line-height:1.7}
.hero-ctas{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:68px}
.btn-primary{padding:15px 34px;background:rgb(var(--r),var(--g),var(--b));color:#fff;border:none;border-radius:12px;font-size:15px;font-family:var(--body);font-weight:700;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:8px}
.btn-primary:hover{filter:brightness(1.1);transform:translateY(-1px)}
.btn-sec{padding:15px 32px;background:rgba(255,255,255,.05);border:1px solid var(--border2);color:var(--text);border-radius:12px;font-size:15px;font-family:var(--body);font-weight:600;transition:all .2s;display:inline-flex;align-items:center;gap:8px;cursor:pointer}
.btn-sec:hover{background:rgba(255,255,255,.09);transform:translateY(-1px)}
.stat-strip{border:1px solid var(--border);border-radius:16px;background:var(--card);overflow:hidden;display:flex;max-width:720px;margin:0 auto}
.stat-item{flex:1;padding:24px 16px;text-align:center;border-right:1px solid var(--border)}
.stat-item:last-child{border-right:none}
.stat-num{font-family:var(--disp);font-weight:700;font-size:21px;color:#fff;letter-spacing:-.5px;margin-bottom:5px}
.stat-lbl{font-family:var(--body);font-weight:600;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.section{padding:100px 24px}
.section-inner{max-width:1080px;margin:0 auto}
.section-head{text-align:center;margin-bottom:56px}
.section-label{font-size:11px;font-family:var(--body);font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgb(var(--r),var(--g),var(--b));margin-bottom:14px}
.section-h2{font-family:var(--disp);font-weight:700;font-size:clamp(26px,3.2vw,40px);letter-spacing:-.5px;color:#fff;line-height:1.15;text-wrap:balance}
.section-sub{font-size:17px;color:var(--muted);margin:16px auto 0;max-width:560px}
.feat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px}
.feat-card{background:linear-gradient(135deg,rgba(var(--r),var(--g),var(--b),.08),rgba(var(--r),var(--g),var(--b),.02));border:1px solid rgba(var(--r),var(--g),var(--b),.22);border-radius:16px;padding:30px 28px;transition:transform .25s ease,border-color .25s,box-shadow .25s}
.feat-card:hover{transform:translateY(-4px);border-color:rgba(var(--r),var(--g),var(--b),.5);box-shadow:0 8px 40px rgba(var(--r),var(--g),var(--b),.15)}
.feat-icon-box{width:52px;height:52px;border-radius:13px;background:linear-gradient(135deg,rgba(var(--r),var(--g),var(--b),.3),rgba(var(--r),var(--g),var(--b),.1));display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:18px}
.feat-name{font-family:var(--disp);font-weight:700;font-size:17px;color:#fff;letter-spacing:-.2px;margin-bottom:9px}
.feat-desc{font-size:14px;color:var(--muted);line-height:1.72}
.cta-band{padding:90px 24px;border-top:1px solid var(--border)}
.cta-inner{max-width:680px;margin:0 auto;text-align:center}
.cta-inner h2{font-family:var(--disp);font-weight:700;font-size:clamp(24px,2.8vw,36px);letter-spacing:-.5px;color:#fff;margin-bottom:16px;text-wrap:balance}
.cta-inner p{font-size:16px;color:var(--muted);margin-bottom:30px}
footer{border-top:1px solid var(--border);padding:32px 48px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px}
.footer-brand{font-family:var(--disp);font-weight:700;font-size:15px;color:var(--muted)}
.footer-links{display:flex;gap:24px}
.footer-links a{font-size:13px;color:var(--muted2);transition:color .2s}
.footer-links a:hover{color:var(--muted)}
.dark-btn{position:fixed;bottom:24px;right:24px;z-index:200;width:42px;height:42px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid var(--border2);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;line-height:1}
.dark-btn:hover{background:rgba(255,255,255,.14)}
.reveal{opacity:0;transform:translateY(24px);transition:opacity .65s ease,transform .65s ease}
.reveal.visible{opacity:1;transform:translateY(0)}
@media(prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none;transition:none}.badge-dot{animation:none}}
@media(max-width:768px){.nav{padding:0 18px}.nav-links,.crumb{display:none}.hero{padding:110px 18px 64px}.hero h1{font-size:30px}.stat-strip{flex-wrap:wrap}.stat-item{flex:1 1 50%}.stat-item:nth-child(1),.stat-item:nth-child(2){border-bottom:1px solid var(--border)}.stat-item:nth-child(2){border-right:none}footer{flex-direction:column;text-align:center;padding:24px 18px}}
`;

const SCRIPTS = `
<script>
(function(){var b=document.body,btn=document.getElementById('darkBtn');function ap(on){b.classList.toggle('dark-deeper',on);btn.textContent=on?'☀️':'🌙';}ap(localStorage.getItem('modus-theme')==='dark');window.tg=function(){var n=!b.classList.contains('dark-deeper');localStorage.setItem('modus-theme',n?'dark':'light');ap(n);};})();
(function(){var els=document.querySelectorAll('.reveal');if(!('IntersectionObserver'in window)){els.forEach(function(e){e.classList.add('visible');});return;}var io=new IntersectionObserver(function(en){en.forEach(function(e){if(e.isIntersecting){e.target.classList.add('visible');io.unobserve(e.target);}});},{threshold:.15});els.forEach(function(e){io.observe(e);});})();
function goTo(u){window.location.href=u;}
</script>`;

function buildSystemPage(sys) {
  const [r,g,b] = sys.accent;
  const feats = sys.features.map(f => `
      <div class="feat-card">
        <div class="feat-icon-box">${f.icon}</div>
        <div class="feat-name">${esc(f.name)}</div>
        <div class="feat-desc">${esc(f.desc)}</div>
      </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(sys.name)} — M-EasyTools AI+</title>
<meta name="description" content="${esc(sys.tagline)}">
${HEAD_FONTS}
<style>${BASE_CSS}</style>
</head>
<body style="--r:${r};--g:${g};--b:${b}">
<nav class="nav">
  <a href="/" class="nav-logo"><div class="logo-dot">M</div>M-EasyTools AI+</a>
  <div class="nav-links">
    <a href="#features">Features</a>
    <a href="/systems">All Tools</a>
    <a href="/login">Sign In</a>
  </div>
  <div class="nav-right">
    <div class="crumb"><a href="/systems">All Tools</a><span class="sep">/</span><span>${esc(sys.label)}</span></div>
    <a class="nav-cta" onclick="goTo('${sys.appUrl}')">Open Tool →</a>
  </div>
</nav>
<section class="hero">
  <div class="hero-glow"></div>
  <div class="hero-grid"></div>
  <div class="hero-content">
    <div class="hero-emblem">${sys.icon}</div>
    <div class="badge-pill"><span class="badge-dot"></span>${esc(sys.label)}</div>
    <h1>${gradientName(sys.name)}</h1>
    <p class="hero-sub">${esc(sys.tagline)}</p>
    <div class="hero-ctas">
      <button class="btn-primary" onclick="goTo('${sys.appUrl}')">Open Tool →</button>
      <a class="btn-sec" href="/systems">← All Tools</a>
    </div>
    <div class="stat-strip">
      <div class="stat-item"><div class="stat-num">${sys.features.length} Tools</div><div class="stat-lbl">Included</div></div>
      <div class="stat-item"><div class="stat-num">Groq AI</div><div class="stat-lbl">Powered</div></div>
      <div class="stat-item"><div class="stat-num">Bilingual</div><div class="stat-lbl">EN · BM</div></div>
      <div class="stat-item"><div class="stat-num">One Login</div><div class="stat-lbl">All Tools</div></div>
    </div>
  </div>
</section>
<section id="features" class="section reveal">
  <div class="section-inner">
    <div class="section-head">
      <div class="section-label">What's Inside</div>
      <h2 class="section-h2">Everything in ${esc(sys.name)}</h2>
      <p class="section-sub">${sys.features.length} focused tools, one workspace — powered by Groq AI.</p>
    </div>
    <div class="feat-grid">${feats}
    </div>
  </div>
</section>
<section class="cta-band reveal">
  <div class="cta-inner">
    <h2>Ready to create?</h2>
    <p>Part of M-EasyTools AI+ — 40+ tools, one login, one subscription.</p>
    <button class="btn-primary" onclick="goTo('${sys.appUrl}')">Open Tool →</button>
  </div>
</section>
<footer>
  <span class="footer-brand">M-EasyTools AI+ · ${esc(sys.label)}</span>
  <div class="footer-links">
    <a href="/systems">All Tools</a>
    <a href="/login">Sign In</a>
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </div>
</footer>
<button class="dark-btn" id="darkBtn" onclick="tg()" aria-label="Toggle dark mode">🌙</button>
${SCRIPTS}
</body>
</html>`;
}

function buildIndexPage() {
  const cards = SYSTEMS.map(s => {
    const [r,g,b] = s.accent;
    return `
      <a class="ix-card" href="/systems/${s.slug}" style="--r:${r};--g:${g};--b:${b}">
        <div class="ix-head"><div class="ix-icon">${s.icon}</div>
          <div><div class="ix-label">${esc(s.label)}</div><div class="ix-name">${esc(s.name)}</div></div>
        </div>
        <p class="ix-desc">${esc(s.tagline)}</p>
        <div class="ix-foot"><span class="ix-cta">View Tool →</span></div>
      </a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>All Tools — M-EasyTools AI+</title>
${HEAD_FONTS}
<style>${BASE_CSS}
.ix-hero{padding:130px 24px 20px;text-align:center;position:relative}
.ix-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;max-width:1180px;margin:0 auto;padding:40px 24px 100px}
.ix-card{display:block;background:linear-gradient(135deg,rgba(var(--r),var(--g),var(--b),.08),rgba(var(--r),var(--g),var(--b),.02));border:1px solid rgba(var(--r),var(--g),var(--b),.22);border-radius:16px;padding:28px 24px;transition:transform .25s ease,border-color .25s,box-shadow .25s}
.ix-card:hover{transform:translateY(-4px);border-color:rgba(var(--r),var(--g),var(--b),.5);box-shadow:0 8px 40px rgba(var(--r),var(--g),var(--b),.15)}
.ix-head{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.ix-icon{width:52px;height:52px;border-radius:13px;background:linear-gradient(135deg,rgba(var(--r),var(--g),var(--b),.3),rgba(var(--r),var(--g),var(--b),.1));display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
.ix-label{font-size:10px;font-family:var(--body);font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgb(var(--r),var(--g),var(--b));margin-bottom:4px}
.ix-name{font-family:var(--disp);font-weight:700;font-size:16px;color:#fff;letter-spacing:-.2px;line-height:1.2}
.ix-desc{font-size:13px;color:var(--muted);line-height:1.65;margin-bottom:18px}
.ix-foot{border-top:1px solid rgba(var(--r),var(--g),var(--b),.15);padding-top:14px}
.ix-cta{font-family:var(--body);font-weight:700;font-size:13px;color:rgb(var(--r),var(--g),var(--b))}
</style>
</head>
<body style="--r:232;--g:98;--b:42">
<nav class="nav">
  <a href="/" class="nav-logo"><div class="logo-dot">M</div>M-EasyTools AI+</a>
  <div class="nav-links"><a href="/">Home</a><a href="/login">Sign In</a></div>
  <div class="nav-right"><a class="nav-cta" href="/login">Start Free →</a></div>
</nav>
<section class="ix-hero">
  <div class="hero-glow"></div>
  <div class="badge-pill" style="position:relative"><span class="badge-dot"></span>All Tools</div>
  <h1 style="font-family:var(--disp);font-weight:700;font-size:clamp(30px,4.2vw,52px);letter-spacing:-.5px;margin:18px 0 14px;color:#fff">One Platform. Every Marketing Tool.</h1>
  <p style="color:var(--muted);max-width:520px;margin:0 auto;font-size:17px">Content, social, email, ads, SEO, commerce, sales, GAO, and PR — one login. Click any tool for details.</p>
</section>
<div class="ix-grid">${cards}
</div>
<footer>
  <span class="footer-brand">M-EasyTools AI+</span>
  <div class="footer-links"><a href="/">Home</a><a href="/login">Sign In</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div>
</footer>
<button class="dark-btn" id="darkBtn" onclick="tg()" aria-label="Toggle dark mode">🌙</button>
${SCRIPTS}
</body>
</html>`;
}

for (const sys of SYSTEMS) {
  router.get('/' + sys.slug, (_req, res) => res.send(buildSystemPage(sys)));
}
router.get('/', (_req, res) => res.send(buildIndexPage()));

module.exports = router;
