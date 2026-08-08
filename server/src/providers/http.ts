// UNOFFICIAL — reverse-engineered, may break without notice
//
// Thin fetch wrapper shared by the provider modules. Everything here exists to
// make an undocumented endpoint fail *legibly*: distinguishing 401/403 (the
// user's token died) from everything else (the endpoint probably moved).

import { request } from 'undici';

/** These endpoints are served to browsers and will reject an obvious bot UA. */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Byte-identical to the User-Agent the Android pairing WebView uses (see
 * PairActivity.MOBILE_UA). Cloudflare binds its clearance cookie to the UA that
 * obtained it, so replaying those cookies from a different UA gets challenged —
 * which would surface as a puzzling auth failure right after a good login.
 * Used by the providers we replay a full cookie jar for.
 */
export const PAIRED_WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

export interface HttpOutcome {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: unknown;
}

export class AuthRejected extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'AuthRejected';
  }
}

export class FetchFailed extends Error {
  constructor(
    readonly detail: string,
    readonly status?: number,
  ) {
    super(detail);
    this.name = 'FetchFailed';
  }
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000,
): Promise<HttpOutcome> {
  let res;
  try {
    res = await request(url, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': BROWSER_UA,
        ...headers,
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      maxRedirections: 2,
    });
  } catch (err) {
    throw new FetchFailed(`network error: ${(err as Error).message}`);
  }

  const body = await res.body.text().catch(() => '');
  const status = res.statusCode;

  if (status === 401 || status === 403) {
    throw new AuthRejected(status, `credentials rejected by ${new URL(url).host} (HTTP ${status})`);
  }

  let json: unknown = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    // A login page instead of JSON is the classic symptom of a dead cookie that
    // the provider answers with a 200 redirect rather than a 401.
    if (/<html|<!doctype/i.test(body.slice(0, 200))) {
      throw new AuthRejected(status, `${new URL(url).host} returned an HTML page instead of JSON (session likely expired)`);
    }
    throw new FetchFailed(`response was not JSON (HTTP ${status})`, status);
  }

  if (status >= 400) {
    throw new FetchFailed(`HTTP ${status} from ${new URL(url).pathname}`, status);
  }

  return { status, headers: res.headers as HttpOutcome['headers'], body, json };
}

/**
 * Tries each candidate URL in order and returns the first that yields JSON.
 * An auth rejection short-circuits immediately — trying more endpoints with a
 * dead token just generates noise and looks like abuse to the provider.
 */
export async function getFirstJson(
  urls: string[],
  headers: Record<string, string>,
): Promise<{ outcome: HttpOutcome; url: string }> {
  const problems: string[] = [];
  for (const url of urls) {
    try {
      const outcome = await getJson(url, headers);
      return { outcome, url };
    } catch (err) {
      if (err instanceof AuthRejected) throw err;
      problems.push(`${new URL(url).pathname}: ${(err as Error).message}`);
    }
  }
  throw new FetchFailed(`no candidate endpoint responded — ${problems.join(' | ')}`);
}
