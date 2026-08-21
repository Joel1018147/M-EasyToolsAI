'use strict';
// M-Ai tool pack — the workspace itself: the team, and the deployment's module
// switchboard.
//
// `teams` / `team_members` are reached ONLY through the asking account's own
// `users.team_id`, resolved inside the SQL from ctx.ownerId. There is no
// argument on either tool that can name a team, so a caller cannot ask about
// one they are not in.
//
// `platform_modules` has no tenancy column — it is the deployment's own list of
// which module pages are switched on, seeded in server.js initDB() and read by
// checkModule(). It is ADMIN_ONLY for the same reason media_directory_summary
// is: a read that cannot be owner-scoped is not a read a self-assignable role
// should reach. See lib/mai/roles.js OWNER.

const { int, day, ts, oneLine, safe, noneFound, ownerIdOf, dbOf } = require('./shared');
const { STAFF, ADMIN_ONLY } = require('../roles');

const TOOLS = [
  {
    name: 'workspace_team',
    description: 'The team this account belongs to and who is in it — each member\'s name, email, team role and ' +
                 'when they joined. Use for "who is on our team", "how many seats are we using", "who has access", ' +
                 '"list the team members", "what plan is our team on".',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the teams table', async (_args, ctx) => {
      const owner = ownerIdOf(ctx);
      // The team is resolved from the ASKING ACCOUNT'S OWN ROW inside the
      // query. No argument names a team, so there is no shape of request that
      // reads another one.
      const t = await dbOf(ctx).query(
        `SELECT t.id, t.name, t.plan, t.owner_id, t.created_at
           FROM teams t
          WHERE t.id = (SELECT team_id FROM users WHERE id = $1)`,
        [owner]
      );
      if (!t.rows.length) {
        return noneFound('team is attached to this account',
          'A team is created by POST /api/teams, which also makes the creating account its owner. ' +
          'Most accounts on this platform work solo and have none.');
      }
      const team = t.rows[0];
      const m = await dbOf(ctx).query(
        `SELECT u.name, u.email, tm.role, tm.joined_at
           FROM team_members tm
           JOIN users u ON u.id = tm.user_id
          WHERE tm.team_id = $1
          ORDER BY tm.joined_at ASC`,
        [team.id]
      );
      const owners = m.rows.filter(x => String(x.role) === 'owner').length;
      return {
        display: `This account is on the team "${oneLine(team.name, 60)}" (plan ${oneLine(team.plan, 30)}), ` +
                 `created ${day(team.created_at)}, with ${m.rows.length} member(s) of whom ${owners} ` +
                 'hold the owner role.',
        data: { teamId: int(team.id), teamName: oneLine(team.name, 60), plan: oneLine(team.plan, 30),
                members: m.rows.length, owners,
                roster: m.rows.map(x => ({ name: oneLine(x.name, 50), role: oneLine(x.role, 20),
                                           joined: day(x.joined_at) })) },
        rows: m.rows.map(x => `${oneLine(x.name, 50)} <${oneLine(x.email, 60)}> — ${oneLine(x.role, 20)}, ` +
                              `joined ${day(x.joined_at)}`),
      };
    }),
  },

  {
    name: 'platform_module_status',
    description: 'Which of this deployment\'s eleven module pages are switched on and which are switched off — ' +
                 'Content, Social, Mail, Ads, SEO, Commerce, Sales, AI Chat, GAO, PR and Audiobook. Use for ' +
                 '"which modules are enabled", "is the PR module on", "what tools are switched off", "module ' +
                 'status", "which pages are live".',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredRoles: ADMIN_ONLY,
    kind: 'read',
    executor: safe('the platform_modules table', async (_args, ctx) => {
      // NO OWNER SCOPE IS POSSIBLE. platform_modules is deployment-wide state
      // read by checkModule() in server.js; it has no user_id and every account
      // sees the same rows. ADMIN_ONLY is the honest answer, not a scope clause
      // that would be theatre.
      const r = await dbOf(ctx).query(
        'SELECT module_id, name, is_enabled, sort_order, updated_at FROM platform_modules ORDER BY sort_order ASC');
      if (!r.rows.length) {
        return noneFound('platform modules are registered on this deployment',
          'The eleven module rows are seeded in server.js initDB() on first boot.');
      }
      const on = r.rows.filter(x => x.is_enabled === true).length;
      const off = r.rows.length - on;
      const disabled = r.rows.filter(x => x.is_enabled !== true).map(x => oneLine(x.name, 40));
      return {
        display: `${r.rows.length} module(s) are registered on this deployment: ${on} enabled and ${off} disabled.` +
                 (off ? ` The disabled one(s): ${disabled.join(', ')}. A disabled module answers 403 to every ` +
                        'request for its page.' : ' Every module page is reachable.'),
        data: { total: r.rows.length, enabled: on, disabled: off, disabledNames: disabled,
                modules: r.rows.map(x => ({ id: oneLine(x.module_id, 30), name: oneLine(x.name, 40),
                                            enabled: x.is_enabled === true })) },
        rows: r.rows.map(x => `${x.is_enabled === true ? 'ON ' : 'OFF'} ${oneLine(x.module_id, 20)} — ` +
                              `${oneLine(x.name, 40)} (updated ${ts(x.updated_at)})`),
      };
    }),
  },
];

module.exports = { TOOLS };
