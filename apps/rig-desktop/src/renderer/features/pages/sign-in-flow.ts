import { useSyncExternalStore } from 'react';
import type { SignInOptions, SignInOutcome, SignInsList } from '@main/rig/pages/page-sign-ins';
import { rpc } from '@renderer/lib/ipc';
import type { BrowserId, PageSignInRecord, SignInFailureReason, SignInSite } from '@shared/pages/sign-in-sites';

/**
 * The sheet's walk-through, one per site (canvas board 18, B–D), kept
 * outside any component so closing the sheet, the page or Settings never
 * loses it: the chip reads "Finish signing in" and the sheet reopens at the
 * step you left (case 1). Nothing is written to the pages profile until
 * main's check passes, so an abandoned flow leaves nothing behind (case 12).
 *
 * 1 share (hosts + profile picker) → 2 heads-up (macOS will ask; only when
 * not yet granted) → 3 verifying → 4 done, or an error step whose actions
 * are always at least two ways out.
 *
 * Listing profiles reads the browser's `Local State`, which is what makes
 * macOS ask about "data from other apps" the first time; so until folder
 * access is known granted, step 1 shows the hosts only and the profiles are
 * listed after the heads-up.
 */

export type FlowStep =
  | { kind: 'share' }
  | { kind: 'heads-up' }
  | { kind: 'verifying'; since: number }
  | { kind: 'done'; record: PageSignInRecord }
  | {
      kind: 'error';
      reason: SignInFailureReason;
      browser?: BrowserId;
      /** Not signed in in Chrome: rig opened the page there and checks again when you come back (case 5). */
      watching?: 'waiting' | 'checking' | 'gave-up';
    };

type Profiles = Extract<SignInOptions, { ok: true }>;

export interface SignInFlow {
  site: SignInSite;
  pageUrl?: string;
  step: FlowStep;
  /** Whether the sheet is showing. A closed flow that isn't done is one to finish. */
  open: boolean;
  /** Installed browsers, with what rig knows of macOS's permissions for each. */
  browsers: SignInsList['browsers'];
  /** Profiles signed in to the site; null until listed. */
  options: Profiles | null;
  picked: { browser: BrowserId; profile: string } | null;
  headsUpSeen: boolean;
  /** "Switch account…": always show the picker. */
  switching: boolean;
  /** Listing profiles right now. */
  busy: boolean;
}

/** Chrome can take ~30s to save a new sign-in to disk: after coming back, look a few more times. */
export const WATCH_RETRY_MS = 10_000;
export const WATCH_RETRIES = 4;

const flows = new Map<string, SignInFlow>();
const listeners = new Set<() => void>();
const watchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l();
}

function set(siteId: string, patch: Partial<SignInFlow> | null): void {
  const current = flows.get(siteId);
  if (patch === null) {
    flows.delete(siteId);
    stopWatch(siteId);
  } else if (current) flows.set(siteId, { ...current, ...patch });
  emit();
}

function stopWatch(siteId: string): void {
  const timer = watchTimers.get(siteId);
  if (timer) clearTimeout(timer);
  watchTimers.delete(siteId);
}

export function getFlow(siteId: string): SignInFlow | undefined {
  return flows.get(siteId);
}

export function subscribeFlows(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSignInFlow(siteId: string | null): SignInFlow | undefined {
  return useSyncExternalStore(subscribeFlows, () => (siteId ? flows.get(siteId) : undefined));
}

/** Whether a flow was started and left before it finished: the chip offers to pick it up. */
export function isUnfinished(flow: SignInFlow | undefined): boolean {
  return !!flow && !flow.open && flow.step.kind !== 'done';
}

/** The heads-up is needed unless macOS already let rig in and the Keychain answers without asking. */
function needsHeadsUp(flow: SignInFlow, browser: BrowserId | null): boolean {
  const access = flow.browsers.find((b) => b.id === browser) ?? flow.browsers[0];
  return !access || access.folder !== 'granted' || access.keychain !== 'silent';
}

function folderKnownGranted(flow: SignInFlow): boolean {
  return flow.browsers.some((b) => b.folder === 'granted');
}

async function loadOptions(siteId: string): Promise<Profiles | null> {
  const flow = flows.get(siteId);
  if (!flow) return null;
  set(siteId, { busy: true });
  const options = await rpc.rig.pages.signInOptions({ site: siteId, ...(flow.pageUrl ? { pageUrl: flow.pageUrl } : {}) }).catch(() => null);
  if (!flows.get(siteId)) return null;
  if (!options) {
    set(siteId, { busy: false, step: { kind: 'error', reason: 'failed' } });
    return null;
  }
  if (!options.ok) {
    set(siteId, { busy: false, step: { kind: 'error', reason: options.reason, ...(options.browser ? { browser: options.browser } : {}) } });
    return null;
  }
  const picked = flow.picked && options.profiles.some((p) => p.browser === flow.picked!.browser && p.dir === flow.picked!.profile) ? flow.picked : null;
  const first = options.profiles[0];
  set(siteId, { busy: false, options, picked: picked ?? (first ? { browser: first.browser, profile: first.dir } : null) });
  return options;
}

/** After listing: nobody signed in (case 5), a choice to make (case 6), or on to the next step. */
async function proceed(siteId: string): Promise<void> {
  const flow = flows.get(siteId);
  if (!flow?.options) return;
  if (flow.options.profiles.length === 0) {
    set(siteId, { step: { kind: 'error', reason: 'not_signed_in' } });
    return;
  }
  if (flow.step.kind !== 'share' && (flow.options.profiles.length > 1 || flow.switching)) {
    set(siteId, { step: { kind: 'share' } });
    return;
  }
  if (needsHeadsUp(flow, flow.picked?.browser ?? null) && !flow.headsUpSeen) {
    set(siteId, { step: { kind: 'heads-up' } });
    return;
  }
  await run(siteId);
}

async function run(siteId: string, mode: 'sign-in' | 'refresh' = 'sign-in'): Promise<void> {
  const flow = flows.get(siteId);
  if (!flow) return;
  if (mode === 'sign-in' && !flow.picked) return;
  const since = Date.now();
  set(siteId, { step: { kind: 'verifying', since } });
  const result: SignInOutcome = await (mode === 'refresh'
    ? rpc.rig.pages.refreshSignIn({ site: siteId })
    : rpc.rig.pages.signIn({ site: siteId, browser: flow.picked!.browser, profile: flow.picked!.profile, ...(flow.pageUrl ? { pageUrl: flow.pageUrl } : {}) })
  ).catch((): SignInOutcome => ({ ok: false, reason: 'failed' }));
  const now = flows.get(siteId);
  // Cancelled, closed or restarted meanwhile: that answer is stale.
  if (!now || now.step.kind !== 'verifying' || now.step.since !== since) return;
  if (result.ok) set(siteId, { step: { kind: 'done', record: result.record }, switching: false });
  else if (result.reason === 'cancelled') set(siteId, { step: { kind: 'share' }, open: false });
  else set(siteId, { step: { kind: 'error', reason: result.reason, ...(result.browser ? { browser: result.browser } : {}) } });
}

async function freshBrowsers(): Promise<SignInsList['browsers']> {
  return (await rpc.rig.pages.signIns().catch(() => null))?.browsers ?? [];
}

export const signInFlow = {
  /**
   * The chip, the banner or Settings: opens the sheet for a site, picking a
   * left flow back up where it was (case 1). `switching` starts over with
   * the picker ("Switch account…").
   */
  async start(site: SignInSite, pageUrl?: string, opts: { switching?: boolean } = {}): Promise<void> {
    const existing = flows.get(site.id);
    if (existing && existing.step.kind !== 'done' && !opts.switching) {
      set(site.id, { open: true, ...(pageUrl && !existing.pageUrl ? { pageUrl } : {}) });
      return;
    }
    stopWatch(site.id);
    flows.set(site.id, {
      site,
      pageUrl,
      step: { kind: 'share' },
      open: true,
      browsers: [],
      options: null,
      picked: null,
      headsUpSeen: false,
      switching: opts.switching === true,
      busy: true,
    });
    emit();
    const browsers = await freshBrowsers();
    if (!flows.get(site.id)) return;
    set(site.id, { browsers, busy: false });
    if (browsers.length === 0) {
      set(site.id, { step: { kind: 'error', reason: 'no_browser' } });
      return;
    }
    // Reading the profile list only when macOS already let rig in: otherwise it would ask before the heads-up.
    if (!folderKnownGranted(flows.get(site.id)!)) return;
    const options = await loadOptions(site.id);
    // No profile is signed in to the site: straight to "sign in in Chrome first" (case 5).
    if (options && options.profiles.length === 0) set(site.id, { step: { kind: 'error', reason: 'not_signed_in' } });
  },

  /** "Refresh from Chrome": the same profile again, with the sheet showing it check. */
  async refresh(site: SignInSite, record: PageSignInRecord, pageUrl?: string): Promise<void> {
    stopWatch(site.id);
    flows.set(site.id, {
      site,
      pageUrl,
      step: { kind: 'share' },
      open: true,
      browsers: await freshBrowsers(),
      options: null,
      picked: { browser: record.browser, profile: record.profile },
      headsUpSeen: true,
      switching: false,
      busy: false,
    });
    emit();
    await run(site.id, 'refresh');
  },

  pick(siteId: string, browser: BrowserId, profile: string): void {
    set(siteId, { picked: { browser, profile } });
  },

  /** Continue, from step 1 or the heads-up. */
  async next(siteId: string): Promise<void> {
    const flow = flows.get(siteId);
    if (!flow || flow.busy) return;
    if (flow.step.kind === 'share') {
      if (!flow.options) {
        set(siteId, { step: { kind: 'heads-up' } });
        return;
      }
      if (flow.options.profiles.length === 0) {
        set(siteId, { step: { kind: 'error', reason: 'not_signed_in' } });
        return;
      }
      if (needsHeadsUp(flow, flow.picked?.browser ?? null) && !flow.headsUpSeen) {
        set(siteId, { step: { kind: 'heads-up' } });
        return;
      }
      await run(siteId);
      return;
    }
    if (flow.step.kind === 'heads-up') {
      set(siteId, { headsUpSeen: true });
      if (!flow.options) {
        if (!(await loadOptions(siteId))) return;
        await proceed(siteId);
        return;
      }
      await run(siteId);
    }
  },

  back(siteId: string): void {
    if (flows.get(siteId)?.step.kind === 'heads-up') set(siteId, { step: { kind: 'share' } });
  },

  /** Try again, from an error: list again when that's what failed, else run the read again. */
  async retry(siteId: string): Promise<void> {
    const flow = flows.get(siteId);
    if (!flow || flow.step.kind !== 'error') return;
    const reason = flow.step.reason;
    if (reason === 'keychain_denied' || reason === 'rejected_by_site' || (reason === 'failed' && flow.options && flow.picked)) {
      await run(siteId);
      return;
    }
    // Listed again from the error step, so `proceed` still offers the picker when there's a choice.
    if (!(await loadOptions(siteId))) return;
    await proceed(siteId);
  },

  /** Cancel while checking: main stops, nothing is written, the chip offers to finish. */
  cancel(siteId: string): void {
    const flow = flows.get(siteId);
    if (!flow) return;
    if (flow.step.kind === 'verifying') void rpc.rig.pages.cancelSignIn({ site: siteId }).catch(() => {});
    set(siteId, { step: flow.step.kind === 'verifying' ? { kind: 'share' } : flow.step, open: false });
  },

  /** Not now / ✕ / Esc: the sheet goes, the flow stays to be finished. A finished one is simply done. */
  close(siteId: string): void {
    const flow = flows.get(siteId);
    if (!flow) return;
    if (flow.step.kind === 'done') set(siteId, null);
    else if (flow.step.kind === 'verifying') signInFlow.cancel(siteId);
    else set(siteId, { open: false });
  },

  /** "Sign in here": the person types into the page instead; the flow is dropped. */
  hereInstead(siteId: string): void {
    const flow = flows.get(siteId);
    if (flow?.step.kind === 'verifying') void rpc.rig.pages.cancelSignIn({ site: siteId }).catch(() => {});
    set(siteId, null);
  },

  /** "Open in Chrome" from "not signed in there": opens the page and watches for the sign-in (case 5). */
  async openInChrome(siteId: string): Promise<void> {
    const flow = flows.get(siteId);
    if (!flow) return;
    const browser = flow.step.kind === 'error' ? flow.step.browser : undefined;
    await rpc.rig.pages.openInBrowser({ url: flow.pageUrl ?? flow.site.checkUrl, ...(browser ? { browser } : {}) }).catch(() => {});
    if (flow.step.kind === 'error' && flow.step.reason === 'not_signed_in') set(siteId, { step: { ...flow.step, watching: 'waiting' } });
  },

  /** Rig's window has focus again: retry what was waiting on the person outside rig (cases 2 and 5). */
  async onFocus(): Promise<void> {
    for (const [siteId, flow] of flows) {
      if (flow.step.kind !== 'error') continue;
      if (flow.step.reason === 'folder_access_denied') await signInFlow.retry(siteId);
      else if (flow.step.reason === 'not_signed_in' && flow.step.watching === 'waiting') await check(siteId, WATCH_RETRIES);
    }
  },
};

/** One look for the sign-in in the browser; a few more, spaced out, while it may still be saving. */
async function check(siteId: string, left: number): Promise<void> {
  stopWatch(siteId);
  const flow = flows.get(siteId);
  if (!flow || flow.step.kind !== 'error') return;
  set(siteId, { step: { ...flow.step, watching: 'checking' } });
  const options = await rpc.rig.pages.signInOptions({ site: siteId, ...(flow.pageUrl ? { pageUrl: flow.pageUrl } : {}) }).catch(() => null);
  const now = flows.get(siteId);
  if (!now || now.step.kind !== 'error') return;
  if (options?.ok && options.profiles.length > 0) {
    const first = options.profiles[0]!;
    set(siteId, { options, picked: { browser: first.browser, profile: first.dir }, open: true });
    await proceed(siteId);
    return;
  }
  if (left <= 0) {
    set(siteId, { step: { ...now.step, watching: 'gave-up' } });
    return;
  }
  watchTimers.set(
    siteId,
    setTimeout(() => void check(siteId, left - 1), WATCH_RETRY_MS)
  );
}

if (typeof window !== 'undefined') window.addEventListener('focus', () => void signInFlow.onFocus());

/** Tests only: forget every flow. */
export function resetSignInFlows(): void {
  for (const id of [...watchTimers.keys()]) stopWatch(id);
  flows.clear();
  emit();
}
