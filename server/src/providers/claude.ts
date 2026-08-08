// UNOFFICIAL — reverse-engineered, may break without notice
//
// Claude (claude.ai) subscription usage.
//
// There is no documented endpoint for this at all — the numbers on
// Settings -> Usage are rendered from an internal org-scoped API. The flow the
// web app performs, and that this module reproduces:
//
//   1. GET /api/organizations          -> list of orgs, each with a `uuid`
//   2. GET /api/organizations/{uuid}/usage  -> the five-hour and seven-day windows
//
// Auth is the `sessionKey` cookie (an `sk-ant-sid01-...` value) captured by the
// Android WebView after a normal login. claude.ai also insists on a browser-ish
// `anthropic-client-platform` header; without it some paths 403 even with a good
// cookie, which would otherwise look like an expired session.
//
// HOW TO REPAIR THIS MODULE when Anthropic moves the endpoint:
//   Open claude.ai in Chrome, DevTools -> Network -> Fetch/XHR, hard-reload, then
//   open Settings -> Usage. Find the response containing the session/weekly
//   percentages and reset times, copy its path, and add it to USAGE_PATHS below.
//   The parser in ./parse.ts finds percentage+reset pairs anywhere in the payload,
//   so usually only the path needs changing.

import { getJson, getFirstJson, AuthRejected, FetchFailed } from './http.js';
import { usageFromPayload } from './parse.js';
import type { ProviderFetchResult, ProviderModule } from '../lib/types.js';
import { logAuthFailure, logFetchFailure, log } from '../lib/log.js';

const ORIGIN = 'https://claude.ai';

/** Paths tried per organization uuid, most likely first. */
const USAGE_PATHS = [
  (org: string) => `${ORIGIN}/api/organizations/${org}/usage`,
  (org: string) => `${ORIGIN}/api/organizations/${org}/usage_limits`,
  (org: string) => `${ORIGIN}/api/organizations/${org}/rate_limits`,
  (org: string) => `${ORIGIN}/api/organizations/${org}/settings/usage`,
];

/** Org-independent paths, tried if the org lookup itself fails. */
const FALLBACK_PATHS = [`${ORIGIN}/api/usage`, `${ORIGIN}/api/bootstrap`];

function cookieHeader(token: string): string {
  const trimmed = token.trim();
  return trimmed.includes('=') ? trimmed : `sessionKey=${trimmed}`;
}

function baseHeaders(token: string): Record<string, string> {
  return {
    cookie: cookieHeader(token),
    referer: `${ORIGIN}/settings/usage`,
    origin: ORIGIN,
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-sha': 'unknown',
  };
}

async function listOrganizationIds(token: string): Promise<string[]> {
  const { json } = await getJson(`${ORIGIN}/api/organizations`, baseHeaders(token));
  if (!Array.isArray(json)) return [];
  const ids: string[] = [];
  for (const org of json) {
    const uuid = (org as { uuid?: unknown })?.uuid;
    if (typeof uuid === 'string') ids.push(uuid);
  }
  return ids;
}

export async function fetchClaudeUsage(
  token: string,
  ctx: { accountId: string },
): Promise<ProviderFetchResult> {
  try {
    const headers = baseHeaders(token);

    let candidates: string[];
    try {
      const orgs = await listOrganizationIds(token);
      candidates = orgs.flatMap((org) => USAGE_PATHS.map((f) => f(org)));
      if (candidates.length === 0) candidates = FALLBACK_PATHS;
      else candidates = [...candidates, ...FALLBACK_PATHS];
    } catch (err) {
      if (err instanceof AuthRejected) throw err;
      // Org listing moved or failed — still worth trying the org-independent paths.
      log.warn(
        { provider: 'claude', accountId: ctx.accountId, detail: (err as Error).message },
        'claude org listing failed, falling back to org-independent paths',
      );
      candidates = FALLBACK_PATHS;
    }

    const { outcome, url } = await getFirstJson(candidates, headers);
    const usage = usageFromPayload(outcome.json);
    if (!usage) {
      logFetchFailure({
        provider: 'claude',
        accountId: ctx.accountId,
        status: outcome.status,
        detail: `no usage windows found in payload from ${new URL(url).pathname} — endpoint shape likely changed`,
      });
      return {
        ok: false,
        kind: 'fetch',
        status: outcome.status,
        detail: 'endpoint responded but contained no recognisable usage window',
      };
    }

    log.info({ provider: 'claude', accountId: ctx.accountId, endpoint: new URL(url).pathname }, 'usage fetched');
    return { ok: true, usage };
  } catch (err) {
    if (err instanceof AuthRejected) {
      logAuthFailure({ provider: 'claude', accountId: ctx.accountId, status: err.status, detail: err.detail });
      return { ok: false, kind: 'auth', status: err.status, detail: err.detail };
    }
    const detail = err instanceof FetchFailed ? err.detail : (err as Error).message;
    logFetchFailure({ provider: 'claude', accountId: ctx.accountId, detail });
    return { ok: false, kind: 'fetch', detail };
  }
}

export const claudeProvider: ProviderModule = {
  id: 'claude',
  displayName: 'Claude',
  repairHint: 'Sign in to claude.ai again in Claudex to refresh the session.',
  fetchUsage: fetchClaudeUsage,
};
