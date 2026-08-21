'use strict';
// M-Ai tool pack — M-EasyPR: releases, distributions and coverage.
//
// ── NOTHING IN THIS FILE CAN SEND ANYTHING. THAT IS THE POINT. ────────────
// `POST /api/pr/distribute` (server.js:830) is the platform's real outbound
// path: it INSERTs a `pr_distributions` row and then emails real journalists
// through Resend. GAUNTLET.md scopes the Consent / Compliance Bar to exactly
// one requirement on this lane — **no M-Ai tool may trigger a send** — because
// a tool that could would put an outbound message to a stranger behind a
// model's judgement, and the model is choosing from a description.
//
// So, structurally and testably:
//   · NO tool here INSERTs into pr_distributions. Every statement below that
//     touches that table is a SELECT.
//   · NO tool here imports resend, nodemailer, helpers/email or fetch.
//   · The one WRITE in this pack changes a LABEL on pr_releases and nothing
//     else, and it refuses to apply a label that would ASSERT a distribution
//     happened unless a pr_distributions row already exists — see
//     set_pr_release_status. A status is a claim about the world; M-Ai may
//     record a claim the platform's own send path already made, and may not
//     manufacture one.
// test/mai-boundary-test.js asserts all four of those against the source.
//
// ── Tenancy ───────────────────────────────────────────────────────────────
// `pr_releases.user_id` and `pr_distributions.user_id` are the tenancy columns
// and every query below binds ctx.ownerId to one of them. `pr_outlet_reports`
// has NO user column: it is reached ONLY through a join to pr_distributions,
// so its owner scope comes from the parent row and is enforced in the SQL.
//
// `media_outlets` and `journalists` have no tenancy column at all — they are
// the shared Modus media directory, seeded identically for every deployment in
// server.js initDB(). The one tool that reads them is ADMIN_ONLY: it discloses
// nothing account-specific, but a read that cannot be owner-scoped is not a
// read a self-assignable role should reach. See lib/mai/roles.js OWNER.

const {
  int, round1, round2, day, ts, oneLine, prPackagePrice,
  DAYS_PARAM, LIMIT_PARAM, SEARCH_PARAM,
  safe, noneFound, sinceDays, ownerIdOf, dbOf,
  refusedTarget, noChangeNeeded, refusedAmbiguous, assertReadBack,
} = require('./shared');

const { STAFF, ADMIN_ONLY } = require('../roles');

/**
 * The statuses `pr_releases.status` actually holds in this codebase.
 *
 *   'draft'      the column default and what POST /api/pr/generate writes.
 *   'submitted'  written by POST /api/pr/distribute (server.js:872) when a
 *                distribution row is created and the emails go out.
 *   'published'  written by the outlet-report confirmation (server.js:1038)
 *                once coverage is recorded.
 *
 * No fourth value is invented. An 'archived' or 'approved' that no other code
 * path writes or reads would be a state the rest of the app cannot render.
 */
const PR_STATUSES = ['draft', 'submitted', 'published'];

/** Statuses that ASSERT a distribution happened. M-Ai may only apply one of
 *  these to a release that already has a pr_distributions row — see the write
 *  tool below for why. */
const DISTRIBUTION_CLAIMING = ['submitted', 'published'];

/**
 * Resolve a press release the staff member named, scoped to their own account.
 * A bare integer is an id; anything else matches the headline or the company
 * name. Both forms carry `AND user_id = $n`.
 */
async function findRelease(ctx, ref) {
  const owner = ownerIdOf(ctx);
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const r = await dbOf(ctx).query(
      'SELECT id, headline, company_name, status FROM pr_releases WHERE id = $1 AND user_id = $2',
      [Number(s), owner]
    );
    return { rows: r.rows };
  }
  const r = await dbOf(ctx).query(
    `SELECT id, headline, company_name, status FROM pr_releases
      WHERE user_id = $1 AND (headline ILIKE '%' || $2 || '%' OR company_name ILIKE '%' || $2 || '%')
      ORDER BY created_at DESC LIMIT 11`,
    [owner, s]
  );
  return { rows: r.rows };
}

const TOOLS = [
  // ── Reads ────────────────────────────────────────────────────────────────
  {
    name: 'pr_release_pipeline',
    description: 'How many press releases this account has in each state — draft, submitted for distribution, and ' +
                 'published — and which ones they are. Use for "which PR releases are still draft", "how many ' +
                 'press releases do we have", "what is in the PR pipeline", "which releases have not gone out", ' +
                 '"show me the drafts", "how many releases were published".',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: PR_STATUSES },
        limit: LIMIT_PARAM,
      },
      required: [],
    },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the pr_releases table', async (args, ctx) => {
      const owner = ownerIdOf(ctx);
      const counts = await dbOf(ctx).query(
        `SELECT COALESCE(NULLIF(TRIM(status), ''), '(no status)') AS status, COUNT(*)::int AS c
           FROM pr_releases WHERE user_id = $1 GROUP BY 1 ORDER BY c DESC, 1 ASC`,
        [owner]
      );
      if (!counts.rows.length) {
        return noneFound('press releases have been written on this account',
          'A release row is created by POST /api/pr/generate, from the PR panel in the workspace.');
      }
      const byStatus = {};
      for (const s of PR_STATUSES) byStatus[s] = 0;
      let other = 0;
      for (const r of counts.rows) {
        const k = String(r.status);
        if (Object.prototype.hasOwnProperty.call(byStatus, k)) byStatus[k] = int(r.c);
        else other += int(r.c);
      }
      const total = counts.rows.reduce((a, x) => a + int(x.c), 0);

      // The optional list. Two statements rather than one built string: the
      // status is bound as $2 when present, and the query without it is a
      // different literal, so no argument is ever concatenated into SQL.
      const listed = args.status
        ? await dbOf(ctx).query(
            `SELECT id, headline, company_name, status, created_at FROM pr_releases
              WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3`,
            [owner, args.status, args.limit])
        : await dbOf(ctx).query(
            `SELECT id, headline, company_name, status, created_at FROM pr_releases
              WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
            [owner, args.limit]);

      const scope = args.status ? `${byStatus[args.status]} in "${args.status}"` : `${total} in total`;

      return {
        display: `${total} press release(s) on this account: ${byStatus.draft} draft, ${byStatus.submitted} ` +
                 `submitted for distribution and ${byStatus.published} published.` +
                 (other > 0
                   ? ` A further ${other} carry a status this platform does not write, or no status at all, and ` +
                     'are in the total but in none of those three.'
                   : '') +
                 ` The list below shows ${scope}, newest first.`,
        data: { total, draft: byStatus.draft, submitted: byStatus.submitted, published: byStatus.published,
                unrecognisedStatus: other, listed: listed.rows.length, filter: args.status || null },
        rows: listed.rows.map(x => `#${int(x.id)} [${oneLine(x.status, 20)}] ${day(x.created_at)} — ` +
                                   `"${oneLine(x.headline, 70)}" (${oneLine(x.company_name, 40)})`),
      };
    }),
  },

  {
    name: 'pr_distribution_summary',
    description: 'What happened to this account\'s press-release distributions — how many were submitted, how many ' +
                 'emails were sent, how many outlets were targeted and how much the packages cost. READS ONLY; ' +
                 'M-Ai cannot start a distribution. Use for "how many releases did we distribute", "how many ' +
                 'journalists did we email", "what did PR distribution cost", "distribution summary", "did our ' +
                 'release go out".',
    parameters: { type: 'object', properties: { days: DAYS_PARAM }, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the pr_distributions table', async (args, ctx) => {
      const days = args.days;
      const r = await dbOf(ctx).query(
        `SELECT COUNT(*)::int AS runs,
                COALESCE(SUM(emails_sent), 0)::int  AS emails,
                COALESCE(SUM(target_outlets), 0)::int AS outlets,
                COALESCE(SUM(package_price), 0)     AS spend,
                COUNT(*) FILTER (WHERE status = 'pending')::int   AS pending,
                COUNT(*) FILTER (WHERE status = 'sent')::int      AS sent,
                COUNT(*) FILTER (WHERE status = 'published')::int AS published
           FROM pr_distributions
          WHERE user_id = $1 AND submitted_at >= $2`,
        [ownerIdOf(ctx), sinceDays(days)]
      );
      const row = r.rows[0] || {};
      const runs = int(row.runs);
      if (!runs) {
        return noneFound(`press-release distributions were submitted in the last ${days} days`,
          'A distribution row is created by POST /api/pr/distribute, which is the only path that emails ' +
          'journalists. M-Ai has no tool that can start one.', { days });
      }
      return {
        display: `${runs} distribution(s) submitted in the last ${days} days, targeting ${int(row.outlets)} ` +
                 `outlet(s) and sending ${int(row.emails)} email(s). By state: ${int(row.pending)} pending, ` +
                 `${int(row.sent)} sent, ${int(row.published)} published. The package prices total ` +
                 `${prPackagePrice(row.spend)} — pr_distributions records no currency beside that figure, so it ` +
                 'is reported as a bare number rather than stamped with one.',
        data: { days, distributions: runs, emailsSent: int(row.emails), targetOutlets: int(row.outlets),
                packagePriceTotal: round2(row.spend),
                pending: int(row.pending), sent: int(row.sent), published: int(row.published) },
        rows: [`Pending: ${int(row.pending)}`, `Sent: ${int(row.sent)}`, `Published: ${int(row.published)}`,
               `Emails sent: ${int(row.emails)}`, `Outlets targeted: ${int(row.outlets)}`],
      };
    }),
  },

  {
    name: 'pr_coverage_report',
    description: 'The media coverage confirmed for this account — which outlets actually published a release, when, ' +
                 'and the audience reach recorded for each. Use for "who picked up our press release", "what ' +
                 'coverage did we get", "which outlets published us", "what was our PR reach", "show the coverage ' +
                 'report".',
    parameters: { type: 'object', properties: { days: DAYS_PARAM, limit: LIMIT_PARAM }, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the pr_outlet_reports table', async (args, ctx) => {
      const { days, limit } = args;
      // pr_outlet_reports has NO user column. Owner scope arrives through the
      // join to pr_distributions, in the SQL, bound as $1 — not through a
      // filter applied afterwards in JavaScript.
      const r = await dbOf(ctx).query(
        `SELECT r.outlet_name, r.publication_url, r.published_at, r.reach_estimate, pr.headline
           FROM pr_outlet_reports r
           JOIN pr_distributions d ON d.id = r.distribution_id
           JOIN pr_releases pr     ON pr.id = d.pr_id
          WHERE d.user_id = $1 AND r.created_at >= $2
          ORDER BY r.published_at DESC NULLS LAST, r.created_at DESC
          LIMIT $3`,
        [ownerIdOf(ctx), sinceDays(days), limit]
      );
      if (!r.rows.length) {
        return noneFound(`media coverage has been confirmed for this account in the last ${days} days`,
          'A coverage row is written when an operator confirms a publication against a distribution.', { days });
      }
      const reach = r.rows.reduce((a, x) => a + int(x.reach_estimate), 0);
      const outlets = new Set(r.rows.map(x => String(x.outlet_name || '').trim().toLowerCase())).size;
      return {
        display: `${r.rows.length} confirmed publication(s) across ${outlets} outlet(s) in the last ${days} days, ` +
                 `with a combined recorded reach estimate of ${reach}. The most recent is ` +
                 `${oneLine(r.rows[0].outlet_name, 50)}.`,
        data: { days, publications: r.rows.length, outlets, totalReach: reach,
                coverage: r.rows.map(x => ({ outlet: oneLine(x.outlet_name, 50), reach: int(x.reach_estimate),
                                             published: day(x.published_at) })) },
        rows: r.rows.map(x => `${day(x.published_at)} — ${oneLine(x.outlet_name, 50)} ` +
                              `(reach ${int(x.reach_estimate)}) for "${oneLine(x.headline, 60)}"`),
      };
    }),
  },

  {
    name: 'media_directory_summary',
    description: 'The shared Modus media directory this platform distributes through — how many outlets and ' +
                 'journalists are on file, by tier and by region. This is platform reference data, identical for ' +
                 'every account. Use for "how many outlets can we reach", "what is in the media database", "how ' +
                 'many journalists do we have", "which regions do we cover", "what does the enterprise tier ' +
                 'include".',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredRoles: ADMIN_ONLY,
    kind: 'read',
    executor: safe('the media_outlets table', async (_args, ctx) => {
      // NO OWNER SCOPE IS POSSIBLE HERE, AND THAT IS WHY THIS TOOL IS
      // ADMIN_ONLY. media_outlets and journalists carry no user_id: they are
      // seeded once in server.js initDB() and are the same rows for every
      // account on the deployment. There is nothing account-specific to leak,
      // and equally nothing to scope — so the narrower role is the honest
      // answer rather than a scope clause that would be theatre.
      const outlets = await dbOf(ctx).query(
        `SELECT tier, region, COUNT(*)::int AS c, COALESCE(SUM(reach_estimate), 0)::int AS reach
           FROM media_outlets WHERE is_active GROUP BY tier, region ORDER BY c DESC, tier ASC, region ASC`
      );
      if (!outlets.rows.length) {
        return noneFound('active media outlets are on file for this deployment',
          'The directory is seeded in server.js initDB() and extended by an operator.');
      }
      const journalists = await dbOf(ctx).query(
        'SELECT COUNT(*)::int AS c FROM journalists WHERE is_active');

      const totalOutlets = outlets.rows.reduce((a, x) => a + int(x.c), 0);
      const totalReach = outlets.rows.reduce((a, x) => a + int(x.reach), 0);
      const totalJournalists = int((journalists.rows[0] || {}).c);
      const tiers = new Set(outlets.rows.map(x => String(x.tier)));

      return {
        display: `The shared media directory holds ${totalOutlets} active outlet(s) across ${tiers.size} tier(s), ` +
                 `with a combined recorded reach estimate of ${totalReach}, and ${totalJournalists} active ` +
                 'journalist contact(s). This is platform reference data — the same rows for every account.',
        data: { outlets: totalOutlets, journalists: totalJournalists, totalReach, tiers: tiers.size,
                breakdown: outlets.rows.map(x => ({ tier: String(x.tier), region: String(x.region),
                                                    outlets: int(x.c), reach: int(x.reach) })) },
        rows: outlets.rows.map(x => `${oneLine(x.tier, 20)} / ${oneLine(x.region, 30)}: ${int(x.c)} outlet(s), ` +
                                    `reach ${int(x.reach)}`),
      };
    }),
  },

  // ── Write ────────────────────────────────────────────────────────────────
  {
    name: 'set_pr_release_status',
    description: 'Set the status label on one of this account\'s press releases — draft, submitted or published. ' +
                 'This changes a LABEL ONLY: it sends nothing, emails nobody and creates no distribution. Use for ' +
                 '"set this release to published", "mark the release as draft again", "change the status of that ' +
                 'press release".',
    parameters: {
      type: 'object',
      properties: {
        release: SEARCH_PARAM,
        status: { type: 'string', enum: PR_STATUSES },
      },
      required: ['release', 'status'],
    },
    requiredRoles: STAFF,
    kind: 'write',
    reversible: true,
    sideEffect: 'change one press release\'s status label. The previous status is reported back so it can be set ' +
                'again; nothing is emailed, no distribution is created and no journalist is contacted — M-Ai has ' +
                'no tool that can do any of those.',
    executor: safe('the pr_releases table', async (args, ctx) => {
      const owner = ownerIdOf(ctx);
      const found = await findRelease(ctx, args.release);
      if (!found.rows.length) return refusedTarget('press release', args.release);
      if (found.rows.length > 1) {
        return refusedAmbiguous('press release', args.release,
          found.rows.map(x => `#${int(x.id)} [${oneLine(x.status, 20)}] — "${oneLine(x.headline, 70)}"`));
      }
      const rel = found.rows[0];
      const previous = String(rel.status || '');
      const next = args.status;
      if (previous === next) return noChangeNeeded(`press release #${int(rel.id)}`, `"${next}"`);

      // ── M-Ai MAY RECORD A CLAIM THE PLATFORM MADE; IT MAY NOT MANUFACTURE ONE
      // 'submitted' and 'published' both ASSERT that this release went out to
      // journalists. The only thing on this platform that can make that true is
      // POST /api/pr/distribute, which inserts a pr_distributions row and mails
      // through Resend — and no M-Ai tool can call it. Letting M-Ai stamp
      // 'published' on a release with no distribution would write a coverage
      // claim that never happened into a table the PR report reads, which is
      // the send-adjacent harm the Consent Bar is pointed at even though no
      // byte leaves the building.
      //
      // Moving BACK to 'draft' is always allowed: it is the undo direction and
      // it retracts a claim rather than making one.
      if (DISTRIBUTION_CLAIMING.includes(next)) {
        const dist = await dbOf(ctx).query(
          'SELECT COUNT(*)::int AS c FROM pr_distributions WHERE pr_id = $1 AND user_id = $2',
          [rel.id, owner]
        );
        if (int((dist.rows[0] || {}).c) === 0) {
          return {
            display: `Refused: press release #${int(rel.id)} has never been distributed, so M-Ai will not label it ` +
                     `"${next}". That status asserts the release went to journalists, and the only thing that can ` +
                     'make it true is the Distribute action in the PR panel, which M-Ai cannot start. ' +
                     'Nothing was changed.',
            data: { changed: false, refused: true, reason: 'no_distribution_exists',
                    releaseId: int(rel.id), requestedStatus: next, distributions: 0 },
            rows: [`#${int(rel.id)} is "${previous}" and has 0 distribution(s)`],
          };
        }
      }

      const upd = await dbOf(ctx).query(
        `UPDATE pr_releases SET status = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND user_id = $3 RETURNING id`,
        [next, rel.id, owner]
      );
      if (!upd.rows.length) return refusedTarget('press release', args.release);

      const back = await dbOf(ctx).query(
        'SELECT status FROM pr_releases WHERE id = $1 AND user_id = $2', [rel.id, owner]);
      assertReadBack(`press release #${int(rel.id)}`, next, back.rows[0] && back.rows[0].status);

      return {
        display: `Press release #${int(rel.id)} ("${oneLine(rel.headline, 70)}") is now "${next}". It was ` +
                 `previously "${previous}" — set it back to that to undo this. Nothing was sent.`,
        data: { changed: true, releaseId: int(rel.id), previousStatus: previous, status: next, sent: false },
        rows: [`#${int(rel.id)}: "${previous}" → "${next}"`],
      };
    }),
  },
];

module.exports = { TOOLS, PR_STATUSES, DISTRIBUTION_CLAIMING, findRelease };
