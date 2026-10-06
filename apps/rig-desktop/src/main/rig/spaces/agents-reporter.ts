import type { Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import type { RelayApiError, SessionAgent } from './relay-api';

/**
 * Tells the relay which agents this Mac can run (`PUT /v1/me/agents`),
 * so its router knows them in spaces where they never ran. The relay keeps
 * one set per computer and takes the union, so a Mac without Codex doesn't
 * erase the Codex on your other Mac. Nudged on launch, whenever settings
 * change (the runnable set is persisted there as probes land) and on a slow
 * interval (a sign-in or account switch has no event of its own). Each
 * nudge waits `debounceMs` for a burst to settle, then sends only when the
 * account or the set differs from what the relay last took, or once a day:
 * the relay forgets a computer that stops reporting.
 * A relay without the route (404) counts as taken: no retries until
 * something changes. Any other failure is retried on the next nudge.
 *
 * Pure apart from the injected deps, so it's unit-tested under `node`; the
 * real wiring lives in `dispatch-controller-instance.ts`.
 */
export type AgentsReporterDeps = {
  /** Whether to report at all (Spaces on). */
  isEnabled: () => boolean;
  /** Who's signed in (any stable key for the account), or null when no one is. */
  account: () => Promise<string | null>;
  /** The agent ids this device can run right now (installed and working). */
  runnable: () => readonly string[];
  /** This Mac's id among the account's computers (`this-mac.ts`). */
  device: () => string;
  put: (agents: SessionAgent[], device: string) => Promise<Result<{ supported: boolean }, RelayApiError>>;
  /** For tests: today's date, so the report is renewed daily. */
  today?: () => string;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export const AGENTS_REPORT_DEBOUNCE_MS = 2_000;

export function reportableAgents(runnable: readonly string[]): SessionAgent[] {
  return (['claude', 'codex'] as const).filter((agent) => runnable.includes(agent));
}

export function createAgentsReporter(deps: AgentsReporterDeps, debounceMs = AGENTS_REPORT_DEBOUNCE_MS) {
  let timer: unknown = null;
  let lastSent: string | null = null;
  let running = false;
  let again = false;

  const sync = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (!deps.isEnabled()) continue;
        const account = await deps.account();
        if (!account) continue;
        const agents = reportableAgents(deps.runnable());
        const device = deps.device();
        const today = deps.today?.() ?? new Date().toISOString().slice(0, 10);
        const key = `${account}|${device}|${agents.join(',')}|${today}`;
        if (key === lastSent) continue;
        const result = await deps.put(agents, device);
        if (result.success) lastSent = key;
        else log.warn('Rig spaces: could not report your agents', { error: result.error.message });
      } while (again);
    } finally {
      running = false;
    }
  };

  return {
    /** Something may have changed: report once things settle. */
    nudge(): void {
      if (timer !== null) deps.clearTimeout(timer);
      timer = deps.setTimeout(() => {
        timer = null;
        void sync();
      }, debounceMs);
    },
    dispose(): void {
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    },
    /** For tests: run the pending report now. */
    flush: sync,
  };
}
