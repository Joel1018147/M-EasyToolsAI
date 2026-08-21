'use strict';
// M-Ai tool pack — generated content and the brand profile that steers it.
//
// Tables: `documents` and `users`. Both are scoped by `user_id` / `id` in the
// SQL itself, bound from ctx.ownerId, which routes/mai.js derives from the
// session. There is no argument on any tool below that can widen that scope.
//
// ── A KNOWN, PRE-EXISTING DEFECT THESE TOOLS REPORT AROUND ────────────────
// `documents.word_count` is computed at save time by `content.split(/\s+/)`
// (server.js POST/PUT /api/documents, and helpers/generation.js). Chinese does
// not put spaces between words, so a whole Chinese article is stored as
// word_count = 1 — UPGRADE-SPEC §0.7, recurring-bug class #7, and Lane C's to
// fix. These tools report the STORED value, because reporting a recomputed one
// would make M-Ai disagree with every other screen in the app about the same
// document. The word-count tools therefore say "as recorded" rather than
// "words", and the descriptions do not promise a length measurement.

const {
  int, round1, round2, day, oneLine,
  DAYS_PARAM, LIMIT_PARAM, SEARCH_PARAM,
  safe, noneFound, sinceDays, ownerIdOf, dbOf,
  refusedTarget, noChangeNeeded, refusedAmbiguous, assertReadBack,
} = require('./shared');

const { STAFF } = require('../roles');

/** The brand tones the workspace UI actually offers (public/app.html:1268). An
 *  enum, not free text: a tone this platform's own dropdown cannot produce is a
 *  value the user can never set back from the UI they normally use. */
const BRAND_TONES = ['Professional', 'Friendly', 'Bold', 'Witty', 'Empathetic', 'Casual'];

/**
 * Resolve a document the staff member named, scoped to their own account.
 *
 * A bare integer is read as an id; anything else is matched against the title.
 * Both forms carry `AND user_id = $n`, so a numeric id belonging to another
 * account resolves to nothing and takes the refusedTarget path — the same
 * sentence a nonexistent id gets, so this is not an oracle for "does document
 * 41 exist somewhere on this platform".
 *
 * An ambiguous title match returns EVERY match and picks nothing.
 */
async function findDocument(ctx, ref) {
  const owner = ownerIdOf(ctx);
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const r = await dbOf(ctx).query(
      'SELECT id, title, tool_name, word_count FROM documents WHERE id = $1 AND user_id = $2',
      [Number(s), owner]
    );
    return { rows: r.rows };
  }
  const r = await dbOf(ctx).query(
    `SELECT id, title, tool_name, word_count FROM documents
      WHERE user_id = $1 AND title ILIKE '%' || $2 || '%'
      ORDER BY created_at DESC LIMIT 11`,
    [owner, s]
  );
  return { rows: r.rows };
}

const TOOLS = [
  // ── Reads ────────────────────────────────────────────────────────────────
  {
    name: 'document_activity_summary',
    description: 'How much content this account has generated over a period — how many documents were saved, ' +
                 'the total recorded word count and the busiest day. Use for "how many documents did we generate ' +
                 'this month", "how much content have we produced", "how many pieces did we write last week", ' +
                 '"what is our content output", "documents created recently".',
    parameters: { type: 'object', properties: { days: DAYS_PARAM }, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the documents table', async (args, ctx) => {
      const days = args.days;
      const since = sinceDays(days);
      const r = await dbOf(ctx).query(
        `SELECT COUNT(*)::int AS docs,
                COALESCE(SUM(word_count), 0)::int AS words,
                COUNT(DISTINCT DATE(created_at))::int AS active_days
           FROM documents
          WHERE user_id = $1 AND created_at >= $2`,
        [ownerIdOf(ctx), since]
      );
      const row = r.rows[0] || {};
      const docs = int(row.docs);
      if (!docs) {
        return noneFound(`documents were saved in the last ${days} days`,
          'Documents are written by the eleven module pages — Content, Social, Mail, Ads, SEO, Sales, ' +
          'Commerce, Audiobook, GAO and PR — through POST /api/generate.',
          { days, words: 0 });
      }
      const words = int(row.words);
      const activeDays = int(row.active_days);
      const perDay = round1(docs / Math.max(1, activeDays));

      const busiest = await dbOf(ctx).query(
        `SELECT DATE(created_at) AS d, COUNT(*)::int AS c
           FROM documents WHERE user_id = $1 AND created_at >= $2
          GROUP BY DATE(created_at) ORDER BY c DESC, d DESC LIMIT 1`,
        [ownerIdOf(ctx), since]
      );
      const top = busiest.rows[0] || null;

      return {
        display: `${docs} document(s) saved in the last ${days} days, totalling ${words} words as recorded at ` +
                 `save time. Work happened on ${activeDays} separate day(s), an average of ${perDay} document(s) ` +
                 'on each day anything was saved.' +
                 (top ? ` The busiest day was ${day(top.d)} with ${int(top.c)}.` : ''),
        data: { days, documents: docs, words, activeDays, perActiveDay: perDay,
                busiestDay: top ? day(top.d) : null, busiestDayCount: top ? int(top.c) : 0 },
        rows: top ? [`Busiest day: ${day(top.d)} — ${int(top.c)} document(s)`] : [],
      };
    }),
  },

  {
    name: 'document_quality_scores',
    description: 'The average SEO score, GEO (generative-engine optimisation) score and readability score across ' +
                 'the documents this account saved in a period, with the best and worst. Use for "what is the ' +
                 'average SEO score", "how are our scores", "what is our average readability", "are our GEO ' +
                 'scores improving", "content quality summary".',
    parameters: { type: 'object', properties: { days: DAYS_PARAM }, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the documents table', async (args, ctx) => {
      const days = args.days;
      const r = await dbOf(ctx).query(
        `SELECT COUNT(*)::int AS docs,
                AVG(seo_score)   AS avg_seo,
                AVG(geo_score)   AS avg_geo,
                AVG(readability) AS avg_read,
                MAX(seo_score)::int AS max_seo,
                MIN(seo_score)::int AS min_seo
           FROM documents
          WHERE user_id = $1 AND created_at >= $2`,
        [ownerIdOf(ctx), sinceDays(days)]
      );
      const row = r.rows[0] || {};
      const docs = int(row.docs);
      if (!docs) {
        return noneFound(`documents were saved in the last ${days} days, so there is nothing to average`,
          'Scores are written by POST /api/generate and POST /api/score when a document is saved.',
          { days });
      }
      const avgSeo = round1(row.avg_seo);
      const avgGeo = round1(row.avg_geo);
      const avgRead = round1(row.avg_read);

      return {
        display: `Across ${docs} document(s) saved in the last ${days} days the average SEO score is ${avgSeo}, ` +
                 `the average GEO score is ${avgGeo} and the average readability score is ${avgRead}. ` +
                 `The best SEO score was ${int(row.max_seo)} and the worst was ${int(row.min_seo)}.`,
        data: { days, documents: docs, avgSeo, avgGeo, avgReadability: avgRead,
                bestSeo: int(row.max_seo), worstSeo: int(row.min_seo) },
        rows: [
          `Average SEO: ${avgSeo}`,
          `Average GEO: ${avgGeo}`,
          `Average readability: ${avgRead}`,
        ],
      };
    }),
  },

  {
    name: 'documents_by_tool',
    description: 'Which of the platform modules produced the most content for this account — Content, Social, ' +
                 'Mail, Ads, SEO, Sales, Commerce, Audiobook, GAO or PR. Use for "which tool do we use most", ' +
                 '"what are we generating", "breakdown by module", "which module is most used", "what kind of ' +
                 'content are we producing".',
    parameters: { type: 'object', properties: { days: DAYS_PARAM, limit: LIMIT_PARAM }, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the documents table', async (args, ctx) => {
      const { days, limit } = args;
      const r = await dbOf(ctx).query(
        `SELECT COALESCE(NULLIF(TRIM(tool_name), ''), '(no tool recorded)') AS tool,
                COUNT(*)::int AS uses,
                COALESCE(SUM(word_count), 0)::int AS words
           FROM documents
          WHERE user_id = $1 AND created_at >= $2
          GROUP BY 1 ORDER BY uses DESC, tool ASC LIMIT $3`,
        [ownerIdOf(ctx), sinceDays(days), limit]
      );
      if (!r.rows.length) {
        return noneFound(`documents were saved in the last ${days} days`,
          'Every module page stamps tool_id and tool_name onto the document it saves.', { days });
      }
      const total = r.rows.reduce((a, x) => a + int(x.uses), 0);
      const top = r.rows[0];
      return {
        display: `${total} document(s) in the last ${days} days across ${r.rows.length} module(s). ` +
                 `The most used is ${oneLine(top.tool, 60)} with ${int(top.uses)}.`,
        data: { days, total, modules: r.rows.length,
                topTool: oneLine(top.tool, 60), topToolUses: int(top.uses),
                breakdown: r.rows.map(x => ({ tool: oneLine(x.tool, 60), uses: int(x.uses), words: int(x.words) })) },
        rows: r.rows.map(x => `${oneLine(x.tool, 60)}: ${int(x.uses)} document(s), ${int(x.words)} words as recorded`),
      };
    }),
  },

  {
    name: 'recent_documents',
    description: 'The most recently saved documents on this account, with their title, the module that made them, ' +
                 'their recorded word count and their SEO score. Use for "what did we write recently", "show me ' +
                 'the latest documents", "what was generated last", "recent content", "what have we saved".',
    parameters: { type: 'object', properties: { limit: LIMIT_PARAM }, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the documents table', async (args, ctx) => {
      const r = await dbOf(ctx).query(
        `SELECT id, title, tool_name, word_count, seo_score, created_at
           FROM documents WHERE user_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [ownerIdOf(ctx), args.limit]
      );
      if (!r.rows.length) {
        return noneFound('documents have been saved on this account',
          'A document is created every time a module page generates content and it is saved.');
      }
      return {
        display: `The ${r.rows.length} most recent document(s) on this account, newest first. ` +
                 `The latest is "${oneLine(r.rows[0].title, 70)}", saved ${day(r.rows[0].created_at)}.`,
        data: { count: r.rows.length,
                documents: r.rows.map(x => ({ id: int(x.id), title: oneLine(x.title, 70),
                                              tool: oneLine(x.tool_name, 40), words: int(x.word_count),
                                              seo: int(x.seo_score), created: day(x.created_at) })) },
        rows: r.rows.map(x => `#${int(x.id)} ${day(x.created_at)} — "${oneLine(x.title, 70)}" ` +
                              `(${oneLine(x.tool_name, 40)}, ${int(x.word_count)} words as recorded, SEO ${int(x.seo_score)})`),
      };
    }),
  },

  {
    name: 'low_scoring_documents',
    description: 'Documents on this account whose SEO, GEO or readability score is below a threshold, so they can ' +
                 'be rewritten. Use for "which content needs work", "what scored badly", "show me weak SEO ' +
                 'documents", "which pages need rewriting", "worst performing content".',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['seo', 'geo', 'readability'], default: 'seo' },
        below: { type: 'integer', minimum: 1, maximum: 100, default: 60 },
        limit: LIMIT_PARAM,
      },
      required: [],
    },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the documents table', async (args, ctx) => {
      const { metric, below, limit } = args;
      // The column is chosen from a FIXED MAP keyed by an enum the schema
      // already pinned — never interpolated from the argument itself. Two
      // independent reasons it can never be attacker-chosen: validateArgs
      // rejects anything outside the enum, and a key not in this object throws
      // here before a query is built.
      const COLUMN = { seo: 'seo_score', geo: 'geo_score', readability: 'readability' };
      const col = COLUMN[metric];
      if (!col) throw new Error(`M-Ai: "${metric}" is not a scored column on documents`);

      // Three separate statements, one per column, rather than one template.
      // Verbose on purpose: it is the only shape in which "no argument reaches
      // SQL text" is true by inspection rather than by argument.
      const SQL = {
        seo: `SELECT id, title, tool_name, seo_score AS score, created_at FROM documents
               WHERE user_id = $1 AND seo_score < $2 ORDER BY seo_score ASC, created_at DESC LIMIT $3`,
        geo: `SELECT id, title, tool_name, geo_score AS score, created_at FROM documents
               WHERE user_id = $1 AND geo_score < $2 ORDER BY geo_score ASC, created_at DESC LIMIT $3`,
        readability: `SELECT id, title, tool_name, readability AS score, created_at FROM documents
               WHERE user_id = $1 AND readability < $2 ORDER BY readability ASC, created_at DESC LIMIT $3`,
      };
      const r = await dbOf(ctx).query(SQL[metric], [ownerIdOf(ctx), below, limit]);
      if (!r.rows.length) {
        return noneFound(`documents on this account score below ${below} on ${metric}`,
          'Scores are written when a document is saved; a document saved before scoring existed carries 0.',
          { metric, below });
      }
      return {
        display: `${r.rows.length} document(s) score below ${below} on ${metric}. ` +
                 `The lowest is "${oneLine(r.rows[0].title, 70)}" at ${int(r.rows[0].score)}.`,
        data: { metric, below, count: r.rows.length, lowest: int(r.rows[0].score),
                documents: r.rows.map(x => ({ id: int(x.id), title: oneLine(x.title, 70), score: int(x.score) })) },
        rows: r.rows.map(x => `#${int(x.id)} ${metric} ${int(x.score)} — "${oneLine(x.title, 70)}" (${oneLine(x.tool_name, 40)})`),
      };
    }),
  },

  {
    name: 'document_publishing_status',
    description: 'How many of this account\'s documents were pushed out to WordPress or to Shopify, and how many ' +
                 'are still only stored here. Use for "how much have we published", "what went to WordPress", ' +
                 '"how many products did we push to Shopify", "what is still unpublished", "publishing summary".',
    parameters: { type: 'object', properties: { days: DAYS_PARAM }, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the documents table', async (args, ctx) => {
      const days = args.days;
      const r = await dbOf(ctx).query(
        `SELECT COUNT(*)::int AS docs,
                COUNT(*) FILTER (WHERE published_wp)::int AS wp,
                COUNT(*) FILTER (WHERE published_shopify)::int AS shopify,
                COUNT(*) FILTER (WHERE NOT published_wp AND NOT published_shopify)::int AS neither
           FROM documents
          WHERE user_id = $1 AND created_at >= $2`,
        [ownerIdOf(ctx), sinceDays(days)]
      );
      const row = r.rows[0] || {};
      const docs = int(row.docs);
      if (!docs) {
        return noneFound(`documents were saved in the last ${days} days`,
          'Publishing is recorded by POST /api/integrations/wordpress/publish and .../shopify/publish.', { days });
      }
      const wp = int(row.wp), shopify = int(row.shopify), neither = int(row.neither);
      return {
        display: `Of ${docs} document(s) saved in the last ${days} days, ${wp} went to WordPress and ${shopify} ` +
                 `went to Shopify. ${neither} have gone to neither and exist only in this workspace.`,
        data: { days, documents: docs, wordpress: wp, shopify, unpublished: neither,
                publishedRate: round2((docs - neither) / docs * 100) },
        rows: [`WordPress: ${wp}`, `Shopify: ${shopify}`, `Neither: ${neither}`],
      };
    }),
  },

  {
    name: 'brand_profile',
    description: 'The brand name, brand description and brand tone stored on this account — the values that steer ' +
                 'every piece of content the platform generates. Use for "what is our brand tone", "what brand ' +
                 'voice are we using", "what is our brand set to", "what tone do we generate in", "show the brand ' +
                 'profile".',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the users table', async (_args, ctx) => {
      const r = await dbOf(ctx).query(
        'SELECT brand_name, brand_desc, brand_tone, plan FROM users WHERE id = $1',
        [ownerIdOf(ctx)]
      );
      const u = r.rows[0];
      if (!u) {
        // Not an empty record — the account asking the question has no row.
        // That is a broken session, not a blank profile, and it must not read
        // as one.
        throw new Error('M-Ai: the asking account has no row in users. Refusing to report an empty brand profile ' +
                        'for an identity this database does not recognise.');
      }
      const name = (u.brand_name || '').trim();
      const desc = (u.brand_desc || '').trim();
      const tone = (u.brand_tone || '').trim();

      const unset = [];
      if (!name) unset.push('brand name');
      if (!desc) unset.push('brand description');

      return {
        display: `Brand tone is ${tone ? `"${oneLine(tone, 40)}"` : 'not set'}` +
                 (name ? `, brand name is "${oneLine(name, 60)}"` : ', brand name is not set') +
                 (desc ? `, and a brand description is stored.` : ', and no brand description is stored.') +
                 (unset.length
                   ? ` ${unset.join(' and ')} ${unset.length > 1 ? 'are' : 'is'} blank, so generation falls back to ` +
                     'the platform default wording for it.'
                   : ''),
        data: {
          brandName: name || null,
          brandTone: tone || null,
          brandDescriptionSet: !!desc,
          brandDescriptionLength: desc.length,
          unset,
        },
        rows: [
          `Brand name: ${name || '(not set)'}`,
          `Brand tone: ${tone || '(not set)'}`,
          `Brand description: ${desc ? oneLine(desc, 120) : '(not set)'}`,
        ],
      };
    }),
  },

  // ── Writes ───────────────────────────────────────────────────────────────
  {
    name: 'rename_document',
    description: 'Change the title of one saved document on this account. Use for "rename that document", ' +
                 '"change the title of the blog post", "retitle document 14".',
    parameters: {
      type: 'object',
      properties: {
        document: SEARCH_PARAM,
        title: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['document', 'title'],
    },
    requiredRoles: STAFF,
    kind: 'write',
    reversible: true,
    sideEffect: 'change one saved document\'s title. The previous title is reported back so it can be set again; ' +
                'the document\'s content, scores and word count are not touched.',
    executor: safe('the documents table', async (args, ctx) => {
      const owner = ownerIdOf(ctx);
      const found = await findDocument(ctx, args.document);
      if (!found.rows.length) return refusedTarget('document', args.document);
      if (found.rows.length > 1) {
        return refusedAmbiguous('document', args.document,
          found.rows.map(x => `#${int(x.id)} — "${oneLine(x.title, 70)}"`));
      }
      const doc = found.rows[0];
      const previous = String(doc.title || '');
      const next = String(args.title).trim();
      if (previous === next) return noChangeNeeded(`document #${int(doc.id)}`, `titled "${oneLine(next, 70)}"`);

      const upd = await dbOf(ctx).query(
        `UPDATE documents SET title = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND user_id = $3 RETURNING id`,
        [next, doc.id, owner]
      );
      if (!upd.rows.length) return refusedTarget('document', args.document);

      // Read back and throw. rowCount:1 says Postgres matched a row, not that
      // the value landed.
      const back = await dbOf(ctx).query(
        'SELECT title FROM documents WHERE id = $1 AND user_id = $2', [doc.id, owner]);
      assertReadBack(`document #${int(doc.id)}`, next, back.rows[0] && back.rows[0].title);

      return {
        display: `Document #${int(doc.id)} is now titled "${oneLine(next, 70)}". It was previously ` +
                 `"${oneLine(previous, 70)}" — set it back with that title to undo this.`,
        data: { changed: true, documentId: int(doc.id), previousTitle: previous, title: next },
        rows: [`#${int(doc.id)}: "${oneLine(previous, 70)}" → "${oneLine(next, 70)}"`],
      };
    }),
  },

  {
    name: 'set_brand_tone',
    description: 'Set the brand tone stored on this account, which steers the wording of everything the platform ' +
                 'generates from now on. Use for "change our brand tone to friendly", "set the brand voice to ' +
                 'bold", "make our tone professional".',
    parameters: {
      type: 'object',
      properties: { tone: { type: 'string', enum: BRAND_TONES } },
      required: ['tone'],
    },
    requiredRoles: STAFF,
    kind: 'write',
    reversible: true,
    sideEffect: 'change the brand tone on this account. The previous tone is reported back so it can be set again; ' +
                'content already saved is not rewritten and its stored wording does not change.',
    executor: safe('the users table', async (args, ctx) => {
      const owner = ownerIdOf(ctx);
      const cur = await dbOf(ctx).query('SELECT brand_tone FROM users WHERE id = $1', [owner]);
      if (!cur.rows.length) return refusedTarget('account', owner);
      const previous = String(cur.rows[0].brand_tone || '');
      const next = args.tone;
      if (previous === next) return noChangeNeeded('the brand tone on this account', `"${next}"`);

      const upd = await dbOf(ctx).query(
        'UPDATE users SET brand_tone = $1 WHERE id = $2 RETURNING id', [next, owner]);
      if (!upd.rows.length) return refusedTarget('account', owner);

      const back = await dbOf(ctx).query('SELECT brand_tone FROM users WHERE id = $1', [owner]);
      assertReadBack('the brand tone', next, back.rows[0] && back.rows[0].brand_tone);

      return {
        display: `The brand tone on this account is now "${next}". It was previously ` +
                 `${previous ? `"${oneLine(previous, 40)}"` : 'not set'} — set it back to undo this. ` +
                 'Content generated from now on uses the new tone; nothing already saved changes.',
        data: { changed: true, previousTone: previous || null, tone: next },
        rows: [`Brand tone: ${previous || '(not set)'} → ${next}`],
      };
    }),
  },
];

module.exports = { TOOLS, BRAND_TONES, findDocument };
