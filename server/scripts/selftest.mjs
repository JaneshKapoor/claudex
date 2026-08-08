/*
 * Dependency-free self-test for the two pieces most likely to fail silently:
 * token encryption, and the shape-tolerant provider payload parser.
 *
 * Run after a build:  node scripts/selftest.mjs
 * Needs no Postgres, no Redis, no network.
 */
process.env.DATABASE_URL ??= 'postgresql://selftest:selftest@localhost:5432/selftest';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.CLAUDEX_ENCRYPTION_KEY ??= 'a'.repeat(64);

const { encryptSecret, decryptSecret, hashDeviceSecret, newPairingCode } = await import('../dist/lib/crypto.js');
const { usageFromPayload, usageFromHeaders, classifyWindows, collectWindows } = await import(
  '../dist/providers/parse.js'
);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\ncrypto');
const secret = 'sk-ant-sid01-' + 'x'.repeat(80);
const blob = encryptSecret(secret);
check('round-trips a session token', decryptSecret(blob) === secret);
check('ciphertext does not contain the plaintext', !blob.includes(secret));
check('two encryptions of the same value differ (random IV)', encryptSecret(secret) !== encryptSecret(secret));
check('tampered ciphertext is rejected', (() => {
  const bytes = Buffer.from(blob, 'base64');
  bytes[bytes.length - 1] ^= 0xff;
  try {
    decryptSecret(bytes.toString('base64'));
    return false;
  } catch {
    return true;
  }
})());
check('device secrets hash to a 64-char digest', hashDeviceSecret('abc').length === 64);
check('pairing codes are 9 chars with a separator', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(newPairingCode()));

console.log('\nparser — Codex-style rate_limits payload');
const codexPayload = {
  rate_limits: {
    primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 3600 },
    secondary: { used_percent: 88, window_minutes: 10080, resets_in_seconds: 200000 },
  },
};
const codex = usageFromPayload(codexPayload);
check('finds the session window', codex?.sessionPct === 42.5, JSON.stringify(codex));
check('finds the weekly window', codex?.weeklyPct === 88);
check('derives a session reset instant', typeof codex?.sessionResetAt === 'string');
check('derives a weekly reset instant', typeof codex?.weeklyResetAt === 'string');

console.log('\nparser — Claude-style nested payload');
const claudePayload = {
  data: {
    five_hour: { utilization: 0.17, resets_at: '2030-01-01T00:00:00Z' },
    seven_day: { utilization: 0.63, resets_at: '2030-01-05T00:00:00Z' },
  },
};
const claude = usageFromPayload(claudePayload);
check('converts a 0-1 fraction to a percentage', claude?.sessionPct === 17, JSON.stringify(claude));
check('classifies seven_day as weekly', claude?.weeklyPct === 63);
check('keeps the absolute reset timestamp', claude?.weeklyResetAt === '2030-01-05T00:00:00.000Z');

console.log('\nparser — fraction vs percentage disambiguation');
// Regression: claude.ai reports utilization as a percentage, so 1 means one
// percent. Treating "<= 1" as a fraction rendered that as a maxed-out 100% bar.
const onePercent = usageFromPayload({
  five_hour: { utilization: 0, resets_at: '2030-01-01T00:00:00Z' },
  seven_day: { utilization: 1, resets_at: '2030-01-05T00:00:00Z' },
});
check('utilization of 1 is one percent, not 100%', onePercent?.weeklyPct === 1, JSON.stringify(onePercent));
check('utilization of 0 stays 0', onePercent?.sessionPct === 0);
check('a true 0-1 fraction is still scaled up', usageFromPayload({ five_hour: { utilization: 0.42 } })?.sessionPct === 42);
check('a plain percentage above 1 is left alone', usageFromPayload({ five_hour: { utilization: 37 } })?.sessionPct === 37);

console.log('\nparser — real captured payloads');
// Trimmed from an actual claude.ai response. Note it reports the same numbers
// twice (limits[] and five_hour/seven_day) and also carries a `spend.percent`
// credits meter that must NOT be mistaken for a usage window.
const claudeReal = {
  spend: { percent: 19, severity: 'normal' },
  limits: [
    { kind: 'session', group: 'session', percent: 3, resets_at: '2026-08-08T23:40:00.000179+00:00' },
    { kind: 'weekly_all', group: 'weekly', percent: 1, resets_at: '2026-08-15T18:00:00.000201+00:00' },
  ],
  five_hour: { resets_at: '2026-08-08T23:40:00.000179+00:00', utilization: 3 },
  seven_day: { resets_at: '2026-08-15T18:00:00.000201+00:00', utilization: 1 },
  extra_usage: { utilization: 19.21333333333333, used_credits: 1441 },
};
const claudeParsed = usageFromPayload(claudeReal);
check('claude session is 3%', claudeParsed?.sessionPct === 3, JSON.stringify(claudeParsed));
check('claude weekly is 1%', claudeParsed?.weeklyPct === 1);
check('the credits meter is not mistaken for a usage window',
  claudeParsed?.sessionPct !== 19 && claudeParsed?.weeklyPct !== 19);

// Trimmed from an actual chatgpt.com response on a "go" plan: a single 30-day
// window, no weekly. The window length must win over the key name "primary".
const chatgptReal = {
  plan_type: 'go',
  rate_limit: {
    primary_window: {
      reset_at: 1788809286,
      used_percent: 0,
      reset_after_seconds: 2592000,
      limit_window_seconds: 2592000,
    },
    secondary_window: null,
  },
};
const chatgptParsed = usageFromPayload(chatgptReal);
check('a 30-day window is not reported as a 5-hour session',
  chatgptParsed?.sessionPct === null, JSON.stringify(chatgptParsed));
check('the long window lands in the long-window slot', chatgptParsed?.weeklyPct === 0);

console.log('\nparser — resilience');
check('unknown shapes return null rather than throwing', usageFromPayload({ hello: 'world' }) === null);
check('null payload returns null', usageFromPayload(null) === null);
check('deeply wrapped payloads are still found', (() => {
  const wrapped = { a: { b: { c: { limits: [{ used_percent: 12, window_minutes: 300 }] } } } };
  return usageFromPayload(wrapped)?.sessionPct === 12;
})());
check('window length wins over key name', (() => {
  // Named "primary" but a 7-day window: length must decide, so this is weekly.
  const w = collectWindows({ primary: { used_percent: 50, window_minutes: 10080 } });
  return classifyWindows(w).weekly?.pct === 50;
})());

console.log('\nparser — Codex CLI response headers');
const fromHeaders = usageFromHeaders({
  'x-codex-primary-used-percent': '33',
  'x-codex-primary-reset-after-seconds': '600',
  'x-codex-secondary-used-percent': '91',
});
check('reads the primary header window', fromHeaders?.sessionPct === 33);
check('reads the secondary header window', fromHeaders?.weeklyPct === 91);

console.log(failures === 0 ? '\nAll self-tests passed.\n' : `\n${failures} self-test(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
