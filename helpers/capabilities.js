/* ═══════════════════════════════════════════════════════════════════════════
   CAPABILITIES — Modus UI Contract §4.3d
   ───────────────────────────────────────────────────────────────────────────
   One source of truth for "what can this deployment actually do right now",
   consumed by three places that must never disagree: the boot log, the
   settings UI, and GET /health/capabilities.

   A VARIABLE THAT EXISTS IS NOT A VARIABLE THAT HAS A VALUE. has() checks for
   a non-empty trimmed value, never for the key's presence. Campus's real
   production incident was a WABA_APP_SECRET that existed as a name and was
   empty at runtime: the webhook accepted unsigned POSTs while every surface
   reported the integration as configured. A has() that returns true for a
   present-but-empty variable reports a broken thing as healthy.

   UNCONFIGURED IS NOT BROKEN. A channel nobody chose to offer is fine. A
   password-reset flow with no mail transport is not — nobody can recover an
   account and nothing says so. The difference is the `severity` field, and it
   is the whole point of this file.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/** True only for a variable that is set AND has a non-empty trimmed value. */
function has(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * severity:
 *   'ok'       working
 *   'optional' not configured, and that is a choice — no user-facing promise
 *              is being broken
 *   'broken'   a user-facing flow is dead and the user is not being told
 */
const CHECKS = [
  {
    key: 'database',
    label: 'PostgreSQL',
    vars: ['DATABASE_URL'],
    required: true,
    consequence: 'Nothing works. The process cannot serve a single authenticated request.',
  },
  {
    key: 'sessions',
    label: 'Session store',
    vars: ['SESSION_SECRET'],
    required: true,
    consequence: 'Nobody can stay signed in.',
  },
  {
    key: 'google_oauth',
    label: 'Google sign-in',
    vars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    required: true,
    consequence: 'The "Continue with Google" button on the sign-in page fails.',
  },
  {
    key: 'ai',
    label: 'Groq AI',
    vars: ['GROQ_API_KEY'],
    required: true,
    consequence: 'Every generation tool — content, social, SEO, ads, PR, GAO — returns an error instead of output. This platform is the tools.',
  },
  {
    key: 'email',
    label: 'Email delivery (Resend)',
    vars: ['RESEND_API_KEY'],
    required: true,
    consequence: 'PR distribution sends nothing and trial-expiry reminders never arrive. Users lose access with no warning.',
  },
  {
    key: 'seller_panel',
    label: 'Seller panel',
    vars: ['SELLER_KEY'],
    required: false,
    consequence: '/seller answers 500 to everyone. Ops cannot see subscriptions.',
  },
  {
    key: 'app_url',
    label: 'Public URL',
    vars: ['APP_URL'],
    required: false,
    consequence: 'OAuth callbacks and emailed links point at localhost.',
  },
];

/**
 * @returns {{healthy: boolean, capabilities: Array}}
 *   healthy is false when anything is 'broken'. An 'optional' gap never makes
 *   the deployment unhealthy — that distinction is the reason this endpoint is
 *   separate from /health, and collapsing it means either the real outage is
 *   buried in noise or the degraded state is invisible.
 */
function snapshot() {
  const capabilities = CHECKS.map((c) => {
    const missing = c.vars.filter((v) => !has(v));
    const severity = missing.length === 0 ? 'ok' : c.required ? 'broken' : 'optional';
    return {
      key: c.key,
      label: c.label,
      severity,
      // Names only. A capability report that echoes values is a credential leak
      // wearing a diagnostics badge.
      missing,
      consequence: severity === 'ok' ? null : c.consequence,
    };
  });
  return { healthy: !capabilities.some((c) => c.severity === 'broken'), capabilities };
}

/**
 * §4.3d requirement 1 — a boot log on every deploy, into Railway where it is
 * actually read, naming each broken flow, the missing variable, and the
 * user-visible consequence in a sentence.
 */
function logBootCapabilities(log = console) {
  const { healthy, capabilities } = snapshot();
  const broken = capabilities.filter((c) => c.severity === 'broken');
  const optional = capabilities.filter((c) => c.severity === 'optional');

  if (healthy && !optional.length) {
    log.log('✓ capabilities: all configured');
    return;
  }
  if (broken.length) {
    log.error('✗ DEGRADED — ' + broken.length + ' user-facing flow(s) are broken and nobody is being told:');
    broken.forEach((c) => log.error(`    ${c.label}  [missing: ${c.missing.join(', ')}]  → ${c.consequence}`));
  }
  if (optional.length) {
    log.log('· not configured (by choice, no user-facing promise broken):');
    optional.forEach((c) => log.log(`    ${c.label}  [missing: ${c.missing.join(', ')}]  → ${c.consequence}`));
  }
}

module.exports = { has, snapshot, logBootCapabilities, CHECKS };
