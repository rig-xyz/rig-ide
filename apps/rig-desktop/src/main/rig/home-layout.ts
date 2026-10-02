import { KV } from '@main/db/kv';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  parseHomeLayout,
  parseHomeLayoutAction,
  rigHomeLayoutChangedChannel,
  type HomeLayout,
  type HomeLayoutAction,
} from '@shared/rig/home-layout';
import { isError, resolveContext } from './account';
import {
  HomeLayoutSync,
  type HomeLayoutCache,
  type HomeLayoutGetResult,
  type HomeLayoutPutResult,
} from './home-layout-sync';
import { localCacheAccountId } from './local-cache-account';

/**
 * Home's layout (`@shared/rig/home-layout`): the relay's
 * `GET/PUT /v1/me/home-layout` (tap `packages/relay/src/routes/
 * home-layout.ts`), this account's cached copy, and the RPC Home calls.
 * The sync logic itself is `home-layout-sync.ts`.
 */

const REQUEST_TIMEOUT_MS = 10_000;

/** Also cleared by `purgeLocalCaches` (sign-out, another account signing in). */
const HOME_LAYOUT_KV_NAMESPACE = 'rig-home-layout';
type Stored = { account: string; cache: HomeLayoutCache };
const memory = new KV<{ state: Stored }>(HOME_LAYOUT_KV_NAMESPACE);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** `{ layout, version }` from the relay. A never-saved layout (null, version 0) reads as the defaults. */
function toSynced(value: unknown): { layout: HomeLayout; version: number } | null {
  const r = asRecord(value);
  if (!r || typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 0)
    return null;
  const layout = r.layout === null ? parseHomeLayout({}) : parseHomeLayout(r.layout);
  return layout ? { layout, version: r.version } : null;
}

async function request(method: 'GET' | 'PUT', body?: unknown): Promise<Response | null> {
  const ctx = await resolveContext();
  if (isError(ctx)) return null;
  try {
    return await fetch(new URL('/v1/me/home-layout', ctx.url), {
      method,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn('home layout: relay request failed', { method, error: String(error) });
    return null;
  }
}

export async function getHomeLayout(): Promise<HomeLayoutGetResult> {
  const res = await request('GET');
  if (!res?.ok) return { kind: 'failed' };
  const synced = toSynced(await res.json().catch(() => null));
  return synced ? { kind: 'ok', synced } : { kind: 'failed' };
}

export async function putHomeLayout(
  layout: HomeLayout,
  version: number
): Promise<HomeLayoutPutResult> {
  const res = await request('PUT', { layout, version });
  if (!res) return { kind: 'failed' };
  if (res.status === 400 || res.status === 413) {
    log.warn('home layout: relay refused the layout', { status: res.status });
    return { kind: 'rejected' };
  }
  if (!res.ok && res.status !== 409) return { kind: 'failed' };
  const synced = toSynced(await res.json().catch(() => null));
  if (!synced) return { kind: 'failed' };
  return res.status === 409 ? { kind: 'conflict', synced } : { kind: 'saved', synced };
}

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

function toCache(value: unknown): HomeLayoutCache | null {
  const r = asRecord(value);
  const base = asRecord(r?.base);
  const layout = parseHomeLayout(base?.layout);
  if (!r || !base || !layout || typeof base.version !== 'number') return null;
  const pending = (Array.isArray(r.pending) ? r.pending : [])
    .map(parseHomeLayoutAction)
    .filter((a): a is HomeLayoutAction => a !== null);
  return { base: { layout, version: base.version }, pending };
}

export const homeLayoutSync = new HomeLayoutSync({
  relay: { get: getHomeLayout, put: putHomeLayout },
  store: {
    account: currentAccount,
    read: async (account) => {
      const stored = await memory.get('state');
      return stored?.account === account ? toCache(stored.cache) : null;
    },
    write: (account, cache) => memory.set('state', { account, cache }),
  },
  emit: (layout) => events.emit(rigHomeLayoutChangedChannel, { layout }),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  now: () => Date.now(),
});

export const rigHomeLayoutController = createRPCController({
  /** The layout Home shows, from this computer's cache; the relay's copy follows on `rigHomeLayoutChangedChannel`. */
  get: (): Promise<HomeLayout> => homeLayoutSync.get(),
  /** Applies one edit and returns the layout after it; saving to the relay happens in the background. */
  apply: async (input: { action: HomeLayoutAction }): Promise<HomeLayout> => {
    const action = parseHomeLayoutAction(input.action);
    return action ? homeLayoutSync.apply(action) : homeLayoutSync.get();
  },
});
