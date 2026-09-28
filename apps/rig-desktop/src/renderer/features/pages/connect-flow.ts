import { useSyncExternalStore } from 'react';
import type { ConnectOptions, ConnectOutcome, SignInsList } from '@main/rig/pages/page-sign-ins';
import { rpc } from '@renderer/lib/ipc';
import type { BrowserConnection, BrowserId, BrowserProfileInfo, SignInFailureReason } from '@shared/pages/sign-in-sites';

/**
 * "Connect Chrome" (board 18, revised): once, from Settings or a page's
 * banner. 1 heads-up (what macOS will ask; skipped when already granted),
 * with a browser choice when several are installed → 2 profile picker, only
 * with more than one profile → 3 connecting (the Keychain read) → done.
 * One flow at a time; `where` says which sheet shows it (Settings, or the
 * page that asked), and `after` runs once connected (sign that page in).
 */

export type ConnectStep =
  | { kind: 'heads-up' }
  | { kind: 'pick' }
  | { kind: 'connecting'; since: number }
  | { kind: 'done'; connection: BrowserConnection }
  | { kind: 'error'; reason: SignInFailureReason | 'no_profiles'; browser?: BrowserId };

export interface ConnectFlow {
  where: string;
  step: ConnectStep;
  browsers: SignInsList['browsers'];
  browser: BrowserId | null;
  /** The chosen browser's profiles, most recently active first; null until listed. */
  profiles: BrowserProfileInfo[] | null;
  picked: string | null;
  busy: boolean;
  after?: () => void;
}

let flow: ConnectFlow | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function patch(next: Partial<ConnectFlow> | null): void {
  flow = next === null || !flow ? null : { ...flow, ...next };
  emit();
}

export function useConnectFlow(where: string): ConnectFlow | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (flow && flow.where === where ? flow : null)
  );
}

/** The heads-up is needed unless macOS already let rig in and the Keychain answers without asking. */
function needsHeadsUp(f: ConnectFlow): boolean {
  const access = f.browsers.find((b) => b.id === f.browser);
  return !access || access.folder !== 'granted' || access.keychain !== 'silent';
}

/** Chrome if it's installed, else the first Chromium browser found. */
function defaultBrowser(browsers: SignInsList['browsers']): BrowserId | null {
  return (browsers.find((b) => b.id === 'chrome') ?? browsers[0])?.id ?? null;
}

async function listProfiles(): Promise<void> {
  if (!flow) return;
  patch({ busy: true });
  const options: ConnectOptions = await rpc.rig.pages.connectOptions().catch((): ConnectOptions => ({ ok: false, reason: 'failed' }));
  if (!flow) return;
  if (!options.ok) {
    patch({ busy: false, step: { kind: 'error', reason: options.reason, ...(options.browser ? { browser: options.browser } : {}) } });
    return;
  }
  const profiles = options.profiles.filter((p) => p.browser === flow!.browser);
  if (options.denied.includes(flow.browser!)) {
    patch({ busy: false, step: { kind: 'error', reason: 'folder_access_denied', browser: flow.browser! } });
    return;
  }
  if (profiles.length === 0) {
    patch({ busy: false, profiles, step: { kind: 'error', reason: 'no_profiles', browser: flow.browser! } });
    return;
  }
  patch({ busy: false, profiles, picked: profiles[0]!.dir });
  if (profiles.length > 1) patch({ step: { kind: 'pick' } });
  else await connectPicked();
}

async function connectPicked(): Promise<void> {
  if (!flow?.browser || !flow.picked) return;
  const since = Date.now();
  patch({ step: { kind: 'connecting', since } });
  const result: ConnectOutcome = await rpc.rig.pages
    .connect({ browser: flow.browser, profile: flow.picked })
    .catch((): ConnectOutcome => ({ ok: false, reason: 'failed' }));
  if (!flow || flow.step.kind !== 'connecting' || flow.step.since !== since) return;
  if (result.ok) {
    const after = flow.after;
    patch({ step: { kind: 'done', connection: result.connection }, after: undefined });
    after?.();
  } else if (result.reason === 'cancelled') patch(null);
  else patch({ step: { kind: 'error', reason: result.reason, ...(result.browser ? { browser: result.browser } : {}) } });
}

export const connectFlow = {
  /** Opens the sheet in `where`; `after` runs once connected. */
  async start(where: string, after?: () => void): Promise<void> {
    flow = { where, step: { kind: 'heads-up' }, browsers: [], browser: null, profiles: null, picked: null, busy: true, ...(after ? { after } : {}) };
    emit();
    const list = await rpc.rig.pages.signIns().catch(() => null);
    if (!flow) return;
    const browsers = list?.browsers ?? [];
    const browser = defaultBrowser(browsers);
    patch({ browsers, browser, busy: false });
    if (!browser) {
      patch({ step: { kind: 'error', reason: 'no_browser' } });
      return;
    }
    if (!needsHeadsUp(flow)) await listProfiles();
  },

  chooseBrowser(browser: BrowserId): void {
    if (flow?.step.kind === 'heads-up') patch({ browser, profiles: null, picked: null });
  },

  pick(profile: string): void {
    patch({ picked: profile });
  },

  /** Continue: after the heads-up, list the profiles; after the picker, connect. */
  async next(): Promise<void> {
    if (!flow || flow.busy) return;
    if (flow.step.kind === 'heads-up') await listProfiles();
    else if (flow.step.kind === 'pick') await connectPicked();
  },

  /** Try again from an error: the listing again (macOS may have been changed meanwhile), which connects when there's one profile. */
  async retry(): Promise<void> {
    if (!flow || flow.step.kind !== 'error') return;
    if (flow.step.reason === 'keychain_denied' && flow.picked) await connectPicked();
    else await listProfiles();
  },

  /** Not now / ✕ / Cancel: nothing is kept; a Keychain prompt still up is left to macOS. */
  close(): void {
    if (flow?.step.kind === 'connecting') void rpc.rig.pages.cancelConnect().catch(() => {});
    patch(null);
  },

  /** Rig's window is focused again: retry a folder-access refusal the person may have just fixed (case 2). */
  async onFocus(): Promise<void> {
    if (flow?.step.kind === 'error' && flow.step.reason === 'folder_access_denied') await connectFlow.retry();
  },
};

if (typeof window !== 'undefined') window.addEventListener('focus', () => void connectFlow.onFocus());

/** Tests only. */
export function resetConnectFlow(): void {
  flow = null;
  emit();
}
