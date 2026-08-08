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

import { getFirstJson, getJson, AuthRejected, FetchFailed } from './http.js';
import { usageFromPayload } from './parse.js';
import type { ProviderFetchResult, ProviderModule } from '../lib/types.js';
import { logAuthFailure, logFetchFailure, log } from '../lib/log.js';

const ORIGIN = 'https://chatgpt.com';

const USAGE_ENDPOINTS = [
  `${ORIGIN}/backend-api/wham/usage`,
  `${ORIGIN}/backend-api/wham/tasks/usage`,
  `${ORIGIN}/backend-api/subscription/usage`,
  `${ORIGIN}/backend-api/me/usage`,
  `${ORIGIN}/backend-api/conversation_limit`,
];

function looksLikeJwt(token: string): boolean {
  return /^ey[A-Za-z0-9_-]+\./.test(token.trim());
}

/** Cookie -> bearer exchange, mirroring what the web client does on page load. */
export async function resolveAccessToken(token: string): Promise<string> {
  const trimmed = token.trim();
  if (looksLikeJwt(trimmed)) return trimmed;

  const cookie = trimmed.includes('=') ? trimmed : `__Secure-next-auth.session-token=${trimmed}`;
  const { json } = await getJson(`${ORIGIN}/api/auth/session`, {
    cookie,
    referer: `${ORIGIN}/`,
  });
  const accessToken = (json as { accessToken?: unknown } | null)?.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    // A valid-looking 200 with no accessToken means the session cookie is spent.
    throw new AuthRejected(401, 'chatgpt session cookie no longer yields an access token');
  }
  return accessToken;
}

export async function fetchChatGptUsage(
  token: string,
  ctx: { accountId: string },
): Promise<ProviderFetchResult> {
  try {
    const accessToken = await resolveAccessToken(token);
    const { outcome, url } = await getFirstJson(USAGE_ENDPOINTS, {
      authorization: `Bearer ${accessToken}`,
      referer: `${ORIGIN}/`,
      origin: ORIGIN,
    });

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
