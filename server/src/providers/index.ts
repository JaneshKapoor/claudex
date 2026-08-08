import type { Provider, ProviderModule, ProviderFetchResult } from '../lib/types.js';
import { claudeProvider } from './claude.js';
import { chatgptProvider } from './chatgpt.js';
import { codexProvider } from './codex.js';
import { log } from '../lib/log.js';

export const providers: Record<Provider, ProviderModule> = {
  claude: claudeProvider,
  chatgpt: chatgptProvider,
  codex: codexProvider,
};

export function getProvider(id: Provider): ProviderModule {
  return providers[id];
}

/**
 * Every provider call goes through here. One provider throwing must never take
 * down the poll cycle or the request — an unexpected throw is downgraded to a
 * `fetch` failure for that provider alone.
 */
export async function safeFetchUsage(
  id: Provider,
  token: string,
  ctx: { accountId: string },
): Promise<ProviderFetchResult> {
  try {
    return await providers[id].fetchUsage(token, ctx);
  } catch (err) {
    log.error(
      { kind: 'provider_module_crash', provider: id, accountId: ctx.accountId, err: (err as Error).message },
      'provider module threw unexpectedly',
    );
    return { ok: false, kind: 'fetch', detail: `provider module crashed: ${(err as Error).message}` };
  }
}
