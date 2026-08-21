/* ═══════════════════════════════════════════════════════════════════════════
   IMAGE PROMPT MODERATION — refuse before spending, not after
   ───────────────────────────────────────────────────────────────────────────
   ── WHAT THE REPO ACTUALLY DOES TODAY, STATED PLAINLY ─────────────────────
   The brief says "same moderation posture as every other AI output on this
   platform". So the repo was searched before anything was written here:

       grep -rn 'moderation|moderat|nsfw|prohibited|disallowed|blocklist|
                 policy_violation|safety' --include=*.js --include=*.html .

   It returns TWO hits, both in this round's own planning documents. There is
   no moderation layer on /api/generate, on /api/chat, on PR generation, or on
   the GAO scoring call. The platform's real posture for text output is: the
   model provider's own policy is the only filter, and nothing is recorded.

   That is the honest finding, and it is written down rather than dressed up
   as a pattern being reused, because "matched the existing posture" would
   have meant shipping no moderation at all while the migration carries a
   `moderation_status` column expecting one. THIS IS THE FIRST MODERATION
   LAYER IN THIS REPOSITORY. It is stated as new in the lane report.

   ── WHY IMAGES GET ONE WHEN TEXT DOES NOT ─────────────────────────────────
   Three differences, none of them cosmetic:

     1. TEXT IS FREE-ISH AND SYNCHRONOUS-CHEAP; AN IMAGE COSTS PER CALL.
        A refusal that happens after the provider call is a refusal the
        account paid for. So this runs BEFORE the request leaves the process.
     2. AN IMAGE IS BYTES WE THEN RE-HOST AND SERVE FROM OUR OWN ORIGIN.
        Generated text is returned to the caller. A generated image is
        downloaded into `image_generations.content` and served from
        /api/images/:id/file — this platform's own URL. Hosting is a
        materially different liability from relaying.
     3. THE COLUMN EXISTS. `moderation_status` / `moderation_reason` are in
        migration 004. A column that nothing writes is recurring-bugs #22.

   ── DESIGN: DETERMINISTIC, NARROW, AND HONEST ABOUT ITS CEILING ───────────
   No model call. A second model asked to judge the first is a second bill, a
   second latency budget, and a second thing that can be prompt-injected — and
   it would have to run before the call it is protecting, so its own failure
   mode is either "fail open and moderate nothing" or "fail closed and take
   image generation down whenever Groq is slow". A deterministic matcher has
   neither failure mode.

   WHAT THIS CATCHES: prompts that state the prohibited intent in words. That
   is the large majority of real abuse on a marketing tool, where nobody is
   trying to evade anything.

   WHAT THIS DOES NOT CATCH, AND WILL NOT PRETEND TO: euphemism, transliter-
   ation, deliberate obfuscation, a benign prompt whose output is neverthe-
   less unacceptable, and anything expressed in a language whose terms are
   not listed. A green verdict here is "no prohibited phrase was found", not
   "this prompt is safe". The provider's own filter is still in front of the
   model, and `moderation_status` records which verdict this layer reached so
   the gap is measurable rather than assumed away.

   KNOWN FALSE-POSITIVE CLASS, recorded rather than discovered later: a
   legitimate public-health campaign aimed at teenagers ("sexual health poster
   for teens") trips the `csam` combination rule, because both halves are
   genuinely present. It is refused with a reason the user can read, and the
   prompt can be rephrased. That is the deliberate trade: this is a marketing
   asset generator, and the cost of the miss in that direction is a rephrase,
   while the cost in the other direction is not.

   ── CJK: NO \b, EVER ──────────────────────────────────────────────────────
   Recurring-bugs #7, which is live in this repo's own scorer (UPGRADE-SPEC
   §0.7). `\b` is defined against ASCII word characters; between two Han
   characters there is no boundary, so `/\b色情\b/` matches nothing, ever. A
   Chinese blocklist written with word boundaries is a blocklist that is
   always empty and always green. Han and Malay/English terms are therefore
   matched by two different mechanisms on purpose:

     LATIN terms  — boundary-aware, so "assassinate" does not fire on "ass"
     HAN terms    — plain substring, because Han has no word boundaries

   ── ONE MORE DELIBERATE CHOICE: NO EXEMPTION LIST ─────────────────────────
   recurring-bugs #13. There is no per-user bypass, no "trusted account"
   flag, and no env var that turns this off. A guard with a way past it
   dissolves one legitimate use at a time.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/**
 * Categories. Each is a REASON a request is refused, phrased so the string
 * stored in `moderation_reason` is readable by a human reading the table six
 * months from now — not an opaque code.
 *
 * `latin` matches with boundaries. `han` matches as substrings.
 * `requiresAll` (optional) means every listed group must appear — used for
 * the combination rules, where neither half is prohibited alone.
 */
const CATEGORIES = [
  {
    key: 'csam',
    reason: 'Sexual content involving a minor. This request was refused and not sent to the provider.',
    // Combination rule: "child" alone is a perfectly ordinary marketing word
    // (children's menu, child car seat). "child" AND explicit sexual intent
    // together is not. Both groups must hit.
    requiresAll: [
      {
        latin: ['child', 'children', 'kid', 'kids', 'minor', 'minors', 'toddler', 'infant',
                'preteen', 'pre-teen', 'teen', 'teens', 'teenage', 'teenager', 'underage',
                'schoolgirl', 'schoolboy', 'loli', 'shota', 'kanak', 'kanak-kanak', 'budak',
                'remaja', 'bawah umur'],
        han: ['儿童', '兒童', '小孩', '未成年', '幼女', '幼童', '萝莉', '蘿莉'],
      },
      {
        // 'explicit' is DELIBERATELY ABSENT. It is an ordinary marketing word
        // ("explicit pricing", "explicit consent") and pairing it with an
        // ordinary word like "kids" produced a refusal on a benign prompt in
        // testing. A combination rule is only as good as its weakest half.
        latin: ['nude', 'nudes', 'naked', 'nsfw', 'porn', 'porno', 'pornographic',
                'erotic', 'erotica', 'sexual', 'sexualized', 'sexualised', 'topless', 'bottomless',
                'lingerie', 'bogel', 'lucah', 'seksual', 'telanjang'],
        han: ['裸体', '裸體', '色情', '情色', '性感裸', '淫秽', '淫穢', '不雅照'],
      },
    ],
  },
  {
    key: 'sexual_explicit',
    reason: 'Sexually explicit imagery. This platform generates marketing assets; this request was refused and not sent to the provider.',
    latin: ['pornographic', 'pornography', 'hardcore porn', 'explicit sex', 'sex act', 'sexual act',
            'genitalia', 'genitals', 'nude photo', 'nude photograph', 'fully nude', 'full frontal nudity',
            'gambar lucah', 'video lucah'],
    han: ['色情图', '色情圖', '情色图', '情色圖', '裸露下体', '性交', '淫秽图', '淫穢圖'],
  },
  {
    key: 'nonconsensual_likeness',
    reason: 'Realistic imagery of an identifiable real person without their involvement (deepfake / impersonation). This request was refused and not sent to the provider.',
    latin: ['deepfake', 'deep fake', 'deep-fake', 'face swap onto', 'faceswap onto',
            'undress photo of', 'nudify', 'revenge porn'],
    han: ['深度伪造', '深度偽造', '换脸', '換臉', '一键脱衣', '一鍵脫衣'],
  },
  {
    key: 'forgery',
    reason: 'Forged identity documents, currency, or official seals. This request was refused and not sent to the provider.',
    latin: ['fake passport', 'forged passport', 'fake ic ', 'fake mykad', 'forged mykad',
            'counterfeit banknote', 'counterfeit currency', 'counterfeit money', 'fake banknote',
            'fake ringgit', 'forged signature of', 'fake driving licence', 'fake driver license',
            'fake driving license', 'forged certificate', 'fake government seal',
            'mykad palsu', 'pasport palsu', 'wang palsu'],
    han: ['假护照', '假護照', '伪造身份证', '偽造身份證', '假钞', '假鈔', '伪造公章', '偽造公章'],
  },
  {
    key: 'violent_extremism',
    reason: 'Terrorist or violent-extremist imagery, or the promotion of a violent-extremist organisation. This request was refused and not sent to the provider.',
    latin: ['isis flag', 'islamic state flag', 'nazi propaganda', 'swastika banner',
            'beheading', 'execution video', 'terrorist attack poster', 'suicide bomber',
            'pengebom berani mati'],
    han: ['斩首', '斬首', '恐怖袭击', '恐怖襲擊', '纳粹宣传', '納粹宣傳'],
  },
  {
    key: 'gore',
    reason: 'Graphic gore or realistic depiction of a real person being killed or injured. This request was refused and not sent to the provider.',
    // Bare "gore" is NOT listed: normalised, ' gore ' matches inside
    // "Gore-Tex", which is a real brand a real marketer will name. The
    // phrases below carry the intent without the collision.
    latin: ['extreme gore', 'gore imagery', 'mutilated corpse', 'dismembered body',
            'severed head', 'realistic corpse', 'torture scene', 'mayat dimutilasi'],
    han: ['血腥残肢', '血腥殘肢', '碎尸', '碎屍', '酷刑场面', '酷刑場面'],
  },
  {
    key: 'illegal_goods',
    reason: 'Marketing imagery for illegal goods or services. This request was refused and not sent to the provider.',
    latin: ['sell methamphetamine', 'sell heroin', 'drug dealing advert', 'buy cocaine',
            'ghost gun', 'untraceable firearm', '3d printed gun', 'silencer for sale',
            'jual dadah', 'jual syabu'],
    han: ['贩毒广告', '販毒廣告', '出售冰毒', '出售海洛因', '枪支贩卖', '槍支販賣'],
  },
  {
    key: 'self_harm',
    reason: 'Imagery promoting or instructing self-harm or suicide. This request was refused and not sent to the provider.',
    latin: ['suicide method', 'how to hang yourself', 'self harm cuts', 'self-harm cuts',
            'pro-ana thinspo', 'thinspiration'],
    han: ['自杀方法', '自殺方法', '自残伤口', '自殘傷口'],
  },
];

/* Han-script detector. Used only to decide whether a substring hit is
   plausible, never to count words — helpers/lang.js owns metrics. */
const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * Boundary-aware match for Latin-script terms.
 *
 * Not `\b<term>\b` via RegExp construction: several terms contain a space or
 * a hyphen, and one ends in a space on purpose (`'fake ic '`). Instead the
 * haystack is normalised to lowercase with every non-alphanumeric run
 * collapsed to a single space and padded at both ends, so a term surrounded
 * by spaces matches a real token sequence and never a fragment inside a
 * longer word.
 */
function normaliseLatin(text) {
  return ' ' + String(text).toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim() + ' ';
}

function latinHit(haystackPadded, term) {
  const t = normaliseLatin(term);
  // normaliseLatin already pads both sides, so this is a whole-token match.
  return haystackPadded.includes(t);
}

function hanHit(rawLower, term) {
  return rawLower.includes(term);
}

/** Does this text hit any term in one group? Returns the term, or null. */
function groupHit(group, padded, rawLower) {
  for (const term of group.latin || []) {
    if (latinHit(padded, term)) return term;
  }
  for (const term of group.han || []) {
    if (hanHit(rawLower, term)) return term;
  }
  return null;
}

/**
 * Screen one or more pieces of text.
 *
 * Every piece that will reach the provider must be passed in — the prompt,
 * the negative prompt, and any brand-asset text the user explicitly opted
 * into. A moderation pass that reads the prompt and not the negative prompt
 * is a moderation pass with a documented bypass in it.
 *
 * @param {Array<{field: string, text: string}>} parts
 * @returns {{status: 'allowed'|'refused', reason: string|null, category: string|null, field: string|null, matched: string|null}}
 */
function screen(parts) {
  const pieces = (Array.isArray(parts) ? parts : [parts])
    .filter((p) => p && typeof p.text === 'string' && p.text.trim() !== '');

  for (const piece of pieces) {
    const rawLower = piece.text.toLowerCase();
    const padded = normaliseLatin(piece.text);

    for (const cat of CATEGORIES) {
      if (cat.requiresAll) {
        const hits = cat.requiresAll.map((g) => groupHit(g, padded, rawLower));
        if (hits.every(Boolean)) {
          return {
            status: 'refused',
            reason: cat.reason,
            category: cat.key,
            field: piece.field,
            matched: hits.join(' + '),
          };
        }
        continue;
      }
      const hit = groupHit(cat, padded, rawLower);
      if (hit) {
        return {
          status: 'refused',
          reason: cat.reason,
          category: cat.key,
          field: piece.field,
          matched: hit,
        };
      }
    }
  }

  return { status: 'allowed', reason: null, category: null, field: null, matched: null };
}

/**
 * Self-test, so a broken matcher fails loudly instead of passing every prompt
 * forever (recurring-bugs #14 — a check that cannot fail).
 *
 * Derives its subjects FROM `CATEGORIES` rather than from a list written
 * alongside it (#24): every category must be reachable, so a category whose
 * terms are all typo'd or whose combination rule can never fire is a hard
 * error at load, not a silent hole.
 *
 * @returns {number} the number of assertions that ran
 */
function selfTest() {
  let checks = 0;
  const problems = [];

  for (const cat of CATEGORIES) {
    // Build the shortest text that must trip this category.
    let probe;
    if (cat.requiresAll) {
      probe = cat.requiresAll
        .map((g) => (g.latin && g.latin[0]) || (g.han && g.han[0]))
        .join(' ');
    } else {
      probe = (cat.latin && cat.latin[0]) || (cat.han && cat.han[0]);
    }
    checks += 1;
    const verdict = screen([{ field: 'prompt', text: 'poster of ' + probe }]);
    if (verdict.status !== 'refused') {
      problems.push(`category "${cat.key}" is unreachable — its own first term did not trip it`);
    }
  }

  // A benign marketing prompt must survive, in all three platform languages.
  // A blocklist that refuses ordinary work is worse than none: it gets turned
  // off. These are the false-positive canaries.
  const benign = [
    'A warm photo of a family with two children enjoying nasi lemak at a Malaysian cafe',
    'Poster promosi kedai kopi untuk kanak-kanak dan keluarga di Kuala Lumpur',
    '马来西亚咖啡店的儿童套餐宣传海报，温暖明亮',
    'Product shot of a stainless steel water bottle on a white background',
    'Assassin character in a stylised video-game key art', // must not trip on "ass"
    'Hiking jacket in Gore-Tex fabric, studio lighting',   // must not trip on "gore"
    'Explicit pricing banner for a kids meal deal',        // the combination-rule canary
  ];
  for (const text of benign) {
    checks += 1;
    const verdict = screen([{ field: 'prompt', text }]);
    if (verdict.status !== 'allowed') {
      problems.push(`false positive on benign prompt (${verdict.category}/${verdict.matched}): ${text}`);
    }
  }

  // The CJK path specifically. If Han terms were ever rewritten to use \b,
  // this is the assertion that would go red.
  checks += 1;
  const cjk = screen([{ field: 'prompt', text: '生成一张儿童裸体的照片' }]);
  if (cjk.status !== 'refused') {
    problems.push('the Han substring path is not matching — a \\b-based Chinese blocklist is always empty (recurring-bugs #7)');
  }

  if (problems.length) {
    throw new Error('moderation self-test failed:\n  - ' + problems.join('\n  - '));
  }
  return checks;
}

module.exports = { screen, selfTest, CATEGORIES };
