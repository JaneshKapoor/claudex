// UNOFFICIAL — reverse-engineered, may break without notice
//
// ChatGPT (chatgpt.com) subscription usage.
//
// What the paired token is:
//   Either the `__Secure-next-auth.session-token` cookie captured by the Android
//   WebView, or an `eyJ...` bearer access token. A cookie is exchanged for a
//   bearer token at /api/auth/session, exactly as the web app does on load.
//
// Where the numbers come from:
//   GET /backend-api/wham/usage  — the endpoint the web app calls to render the
//   usage screen. It reports rate-limit windows as {used_percent, resets_at,
//   window_minutes}. Fallback candidates are tried in order because OpenAI has
//   moved this path before.
//
// If this breaks: open chatgpt.com in Chrome with DevTools -> Network -> Fetch/XHR,
// visit Settings, and look for the request whose response carries the percentages.
// Add its path to USAGE_ENDPOINTS below; the parser is shape-tolerant.

import { getFirstJson, getJson, AuthRejected, FetchFailed, PAIRED_WEBVIEW_UA } from './http.js';
import { usageFromPayload } from './parse.js';
import type { ProviderFetchResult, ProviderModule } from '../lib/types.js';
import { logAuthFailure, logFetchFailure, log } from '../lib/log.js';

const ORIGIN = 'https://chatgpt.com';

// The first two are live (they answer 401 unauthenticated rather than 404); the
// rest are retired paths kept as cheap insurance for anyone the change has not
// rolled out to. A failed candidate costs one round trip and is skipped.
export const USAGE_ENDPOINTS = [
  `${ORIGIN}/backend-api/wham/usage`,
  `${ORIGIN}/backend-api/wham/tasks/usage`,
  `${ORIGIN}/backend-api/subscription/usage`,
  `${ORIGIN}/backend-api/me/usage`,
  `${ORIGIN}/backend-api/conversation_limit`,
];

/** Alias so the self-test can assert ordering without importing two `USAGE_ENDPOINTS`. */
export const CHATGPT_USAGE_ENDPOINTS = USAGE_ENDPOINTS;

function looksLikeJwt(token: string): boolean {
  return /^ey[A-Za-z0-9_-]+\./.test(token.trim());
}

/**
 * The paired value is the whole cookie jar captured at login (Cloudflare's
 * clearance cookies matter, not just the session token), a bare session token, or
 * an already-exchanged bearer JWT. Normalise to a Cookie header.
 */
export function toCookieHeader(token: string): string {
  const trimmed = token.trim();
  return trimmed.includes('=') ? trimmed : `__Secure-next-auth.session-token=${trimmed}`;
}

/** Cookie -> bearer exchange, mirroring what the web client does on page load. */
export async function resolveAccessToken(token: string): Promise<string> {
  const trimmed = token.trim();
  if (looksLikeJwt(trimmed)) return trimmed;

  const { json } = await getJson(`${ORIGIN}/api/auth/session`, {
    cookie: toCookieHeader(trimmed),
    referer: `${ORIGIN}/`,
    'user-agent': PAIRED_WEBVIEW_UA,
  });
  const accessToken = (json as { accessToken?: unknown } | null)?.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    // A valid-looking 200 with no accessToken means the session cookie is spent.
    throw new AuthRejected(401, 'chatgpt session cookie no longer yields an access token');
  }
  return accessToken;
}

/**
 * Builds the auth strategies to try, best first.
 *
 * The bearer token is what the web app uses, but the exchange that produces it can
 * fail on its own (Cloudflare challenge, a moved /api/auth/session) while the
 * cookies remain perfectly valid. Treating that as an immediate auth failure would
 * tell the user to re-pair a session that is actually fine, so the raw cookie jar
 * is kept as a second attempt.
 */
async function authStrategies(
  token: string,
  ctx: { accountId: string },
): Promise<Array<{ label: string; headers: Record<string, string> }>> {
  const cookie = toCookieHeader(token);
  const base: Record<string, string> = {
    cookie,
    referer: `${ORIGIN}/`,
    origin: ORIGIN,
    'user-agent': PAIRED_WEBVIEW_UA,
  };

  const strategies: Array<{ label: string; headers: Record<string, string> }> = [];
  try {
    const accessToken = await resolveAccessToken(token);
    strategies.push({ label: 'bearer', headers: { ...base, authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    log.warn(
      { provider: 'chatgpt', accountId: ctx.accountId, detail: (err as Error).message },
      'chatgpt bearer exchange failed, falling back to cookie auth',
    );
  }
  strategies.push({ label: 'cookie', headers: base });
  return strategies;
}

export async function fetchChatGptUsage(
  token: string,
  ctx: { accountId: string },
): Promise<ProviderFetchResult> {
  try {
    const strategies = await authStrategies(token, ctx);

    let lastError: Error | null = null;
    let attempt: { outcome: Awaited<ReturnType<typeof getFirstJson>>['outcome']; url: string } | null = null;

    for (const strategy of strategies) {
      try {
        attempt = await getFirstJson(USAGE_ENDPOINTS, strategy.headers);
        break;
      } catch (err) {
        lastError = err as Error;
        // Keep going: an auth rejection on the bearer path may still succeed on cookies.
      }
    }
    if (!attempt) throw lastError ?? new FetchFailed('no chatgpt auth strategy succeeded');

    const { outcome, url } = attempt;
    const usage = usageFromPayload(outcome.json);
    if (!usage) {
      logFetchFailure({
        provider: 'chatgpt',
        accountId: ctx.accountId,
        status: outcome.status,
        detail: `no usage windows found in payload from ${new URL(url).pathname}`,
      });
      return {
        ok: false,
        kind: 'fetch',
        status: outcome.status,
        detail: 'endpoint responded but contained no recognisable usage window',
      };
    }

    log.info({ provider: 'chatgpt', accountId: ctx.accountId, endpoint: new URL(url).pathname }, 'usage fetched');
    return { ok: true, usage };
  } catch (err) {
    if (err instanceof AuthRejected) {
      logAuthFailure({ provider: 'chatgpt', accountId: ctx.accountId, status: err.status, detail: err.detail });
      return { ok: false, kind: 'auth', status: err.status, detail: err.detail };
    }
    const detail = err instanceof FetchFailed ? err.detail : (err as Error).message;
    logFetchFailure({ provider: 'chatgpt', accountId: ctx.accountId, detail });
    return { ok: false, kind: 'fetch', detail };
  }
}

export const chatgptProvider: ProviderModule = {
  id: 'chatgpt',
  displayName: 'ChatGPT',
  repairHint: 'Sign in to chatgpt.com again in Claudex to refresh the session.',
  fetchUsage: fetchChatGptUsage,
};
