// UNOFFICIAL — reverse-engineered, may break without notice
//
// Codex usage.
//
// Codex authenticates with the same ChatGPT account, but bills against its own
// rate-limit windows, so it is tracked as a separate provider card. Two sources,
// in order of preference:
//
//   1. GET /backend-api/wham/usage with the `codex` client headers. The Codex CLI
//      sends `originator: codex_cli_rs`, and the response carries a `rate_limits`
//      object with `primary` (the ~5h window) and `secondary` (the weekly window).
//   2. The same limits mirrored into `x-codex-primary-*` response headers — this is
//      what the CLI's own /status command reads. Used when the body has no windows.
//
// If a Codex link is created without its own token it reuses the ChatGPT link's
// token, since it is the same underlying account session.

import { getFirstJson, AuthRejected, FetchFailed, PAIRED_WEBVIEW_UA } from './http.js';
import { usageFromPayload, usageFromHeaders } from './parse.js';
import { resolveAccessToken, toCookieHeader } from './chatgpt.js';
import type { ProviderFetchResult, ProviderModule } from '../lib/types.js';
import { logAuthFailure, logFetchFailure, log } from '../lib/log.js';

const ORIGIN = 'https://chatgpt.com';

const USAGE_ENDPOINTS = [
  `${ORIGIN}/backend-api/wham/usage`,
  `${ORIGIN}/backend-api/codex/usage`,
];

/** Headers the Codex CLI identifies itself with; the response differs without them. */
const CODEX_HEADERS: Record<string, string> = {
  originator: 'codex_cli_rs',
  'openai-beta': 'responses=experimental',
  'chatgpt-account-id': '',
};

export async function fetchCodexUsage(
  token: string,
  ctx: { accountId: string },
): Promise<ProviderFetchResult> {
  try {
    const headers: Record<string, string> = {
      cookie: toCookieHeader(token),
      referer: `${ORIGIN}/`,
      origin: ORIGIN,
      'user-agent': PAIRED_WEBVIEW_UA,
    };
    // Same reasoning as the ChatGPT module: a failed bearer exchange does not mean
    // the session is dead, so fall through to cookie auth rather than giving up.
    try {
      headers['authorization'] = `Bearer ${await resolveAccessToken(token)}`;
    } catch (err) {
      log.warn(
        { provider: 'codex', accountId: ctx.accountId, detail: (err as Error).message },
        'codex bearer exchange failed, falling back to cookie auth',
      );
    }
    for (const [k, v] of Object.entries(CODEX_HEADERS)) {
      if (v) headers[k] = v;
    }
    headers['originator'] = CODEX_HEADERS['originator']!;

    const { outcome, url } = await getFirstJson(USAGE_ENDPOINTS, headers);

    // Prefer the body; fall back to the CLI-style response headers.
    const usage = usageFromPayload(outcome.json) ?? usageFromHeaders(outcome.headers);
    if (!usage) {
      logFetchFailure({
        provider: 'codex',
        accountId: ctx.accountId,
        status: outcome.status,
        detail: `no usage windows in body or headers from ${new URL(url).pathname}`,
      });
      return {
        ok: false,
        kind: 'fetch',
        status: outcome.status,
        detail: 'endpoint responded but contained no recognisable Codex usage window',
      };
    }

    log.info({ provider: 'codex', accountId: ctx.accountId, endpoint: new URL(url).pathname }, 'usage fetched');
    return { ok: true, usage };
  } catch (err) {
    if (err instanceof AuthRejected) {
      logAuthFailure({ provider: 'codex', accountId: ctx.accountId, status: err.status, detail: err.detail });
      return { ok: false, kind: 'auth', status: err.status, detail: err.detail };
    }
    const detail = err instanceof FetchFailed ? err.detail : (err as Error).message;
    logFetchFailure({ provider: 'codex', accountId: ctx.accountId, detail });
    return { ok: false, kind: 'fetch', detail };
  }
}

export const codexProvider: ProviderModule = {
  id: 'codex',
  displayName: 'Codex',
  repairHint: 'Codex uses your ChatGPT session — re-pair ChatGPT to restore it.',
  fetchUsage: fetchCodexUsage,
};
