import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  parseRecentThemes,
  type RigRecentTheme,
  type RigRecentThemes,
} from '@shared/rig/recent-themes';
import { isError, resolveContext } from './account';
import { localCacheAccountId } from './local-cache-account';

/**
 * Home's Room themes of the last 24h across the account's spaces: `GET
 * /v1/me/themes/recent` (tap `packages/relay/src/routes/themes.ts`). Only
 * themes the relay's worker already made; no model call happens for this.
 *
 * The last answer is kept per account and relay, so an offline Home still
 * shows it. Also cleared by `purgeLocalCaches` (sign-out, another account).
 */

const REQUEST_TIMEOUT_MS = 10_000;

export const RECENT_THEMES_KV_NAMESPACE = 'rig-recent-themes';
type Stored = { account: string; savedAt: number; themes: RigRecentTheme[] };
const memory = new KV<{ state: Stored }>(RECENT_THEMES_KV_NAMESPACE);

async function currentAccount(): Promise<string | null> {
  const accountId = await localCacheAccountId();
  const ctx = await resolveContext();
  if (!accountId || isError(ctx)) return null;
  try {
    return `${accountId}@${new URL(ctx.url).host}`;
  } catch {
    return null;
  }
}

async function readCached(): Promise<RigRecentThemes> {
  try {
    const account = await currentAccount();
    const stored = await memory.get('state');
    if (!account || stored?.account !== account) return { kind: 'none' };
    return { kind: 'cached', themes: stored.themes, savedAt: stored.savedAt };
  } catch (error) {
    log.warn('recent themes: could not read the cache', { error: String(error) });
    return { kind: 'none' };
  }
}

async function fetchLive(): Promise<RigRecentTheme[] | null> {
  const ctx = await resolveContext();
  if (isError(ctx)) return null;
  try {
    const response = await fetch(new URL('/v1/me/themes/recent', ctx.url), {
      headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn('recent themes: relay answered with an error', { status: response.status });
      return null;
    }
    return parseRecentThemes(await response.json().catch(() => null));
  } catch (error) {
    log.warn('recent themes: relay request failed', { error: String(error) });
    return null;
  }
}

/** The relay's answer (and remembered), else this account's last one, else nothing. */
export async function getRecentThemes(): Promise<RigRecentThemes> {
  const themes = await fetchLive();
  if (!themes) return readCached();
  const savedAt = Date.now();
  const account = await currentAccount().catch(() => null);
  if (account) await memory.set('state', { account, savedAt, themes });
  return { kind: 'live', themes, savedAt };
}

export const rigRecentThemesController = createRPCController({
  /** Asks the relay; falls back to the last answer kept on this computer. */
  get: (): Promise<RigRecentThemes> => getRecentThemes(),
  /** This computer only, never the relay: what Home shows while the first answer loads. */
  cached: (): Promise<RigRecentThemes> => readCached(),
});
