import type {
  RunStartedBy,
  RunStepKind,
  SpaceCheck,
  SpaceRun,
  SpaceState,
  ViewRefreshSkip,
  ViewWork,
} from '@shared/rig/space-state';
import { viewNextDueMs } from '@shared/rig/views';

/**
 * What this Mac knows about a space's standing work and turns (spike, Rig Alpha): per view, its
 * schedule, whose session runs it, the last refresh, when it is next due and why a due refresh was
 * skipped; per turn this Mac runs, what started it, its state and its step in plain words. The
 * renderer reads it over IPC (`spaceState`); a later orchestrator tool reads the same object, so
 * it is plain JSON.
 *
 * Why memory, not a file in the space (decision): every fact here is either rebuilt from what
 * already exists (the schedule from view.json, the data's age from data.json's mtime, a run's
 * status from the relay) or is true only for this app process (is a session busy here, what step
 * is it on). A file in the space would sync one Mac's local facts to every member as if they were
 * shared, rewrite through sync on every step, and wake the file watcher. The cost, accepted: after
 * an app restart the last refresh result and the "last tried" time are gone, exactly as the view
 * clock's own `lastStarted` map is today.
 *
 * Written only by the main process; never decides anything. Pure (no Electron), so it is
 * unit-tested under `node`; the singleton that pushes changes to windows is `space-state-instance.ts`.
 */
export type SeenView = {
  name: string;
  everyMs: number | null;
  runsAs: string | null;
  dataModifiedMs: number | null;
  lastStartedMs: number | null;
  /** It runs as this Mac's person, who has not agreed to this schedule. Absent: nothing to agree to. */
  needsAccept?: boolean;
};

export const RUN_KEPT_AFTER_END_MS = 15 * 60_000;
export const RUN_SILENT_DROP_MS = 45 * 60_000;
export const RUNS_KEPT = 20;

const BASE_MAX = 40;

function fileBase(payload: Record<string, unknown>): string | null {
  const locations = payload.locations;
  if (!Array.isArray(locations)) return null;
  const first: unknown = locations[0];
  const path = first && typeof first === 'object' ? (first as { path?: unknown }).path : null;
  if (typeof path !== 'string') return null;
  const base = path.split(/[\\/]/).filter(Boolean).pop();
  return base ? base.slice(0, BASE_MAX) : null;
}

/** A tool call in plain words. Never a raw command or a full path. */
export function runStep(payload: Record<string, unknown>): { step: string; stepKind: RunStepKind } {
  const title = typeof payload.title === 'string' ? payload.title : '';
  const mcp = /^mcp__(.+?)__/.exec(title) ?? /^mcp\.(.+?)\./.exec(title);
  if (mcp) {
    const server = mcp[1];
    if (server === 'rig') return { step: 'Checking the space', stepKind: 'tool' };
    const name = server.replace(/^claude_ai_/, '').replace(/[_-]/g, ' ');
    return { step: `Using ${name}`, stepKind: 'tool' };
  }
  const base = fileBase(payload);
  switch (payload.kind) {
    case 'read':
      return { step: base ? `Reading ${base}` : 'Reading a file', stepKind: 'reading' };
    case 'edit':
      return { step: base ? `Writing ${base}` : 'Writing a file', stepKind: 'writing' };
    case 'delete':
      return { step: 'Removing a file', stepKind: 'writing' };
    case 'move':
      return { step: 'Moving a file', stepKind: 'writing' };
    case 'search':
      return { step: 'Searching', stepKind: 'searching' };
    case 'execute':
      return { step: 'Running a command', stepKind: 'running' };
    case 'fetch':
      return { step: 'Reading a web page', stepKind: 'reading' };
    case 'think':
      return { step: 'Thinking', stepKind: 'thinking' };
    default:
      return { step: 'Working', stepKind: 'thinking' };
  }
}

type Held = { run: SpaceRun; pending: Set<string> };
type Space = { views: Map<string, ViewWork>; runs: Map<string, Held>; check?: SpaceCheck };

export function createSpaceStateStore(deps: { now: () => number; onChange?: (bindingId: string) => void }) {
  const spaces = new Map<string, Space>();
  let me: string | null = null;

  const space = (bindingId: string): Space => {
    let s = spaces.get(bindingId);
    if (!s) {
      s = { views: new Map(), runs: new Map() };
      spaces.set(bindingId, s);
    }
    return s;
  };
  const viewsJson = (s: Space) => JSON.stringify([...s.views.values()]);
  const bareView = (view: string): ViewWork => ({
    view,
    everyMs: null,
    runsAs: null,
    runsHere: null,
    needsAccept: false,
    dataModifiedMs: null,
    refreshingRunId: null,
    lastRefresh: null,
    nextDueAt: null,
    skipped: null,
  });

  /** Runs `change`, and tells `onChange` once when what `get` would show for the views or that run differs. */
  function watching(bindingId: string, runId: string | null, change: (s: Space) => void): void {
    const s = space(bindingId);
    const before = `${viewsJson(s)}|${runId ? JSON.stringify(s.runs.get(runId)?.run ?? null) : ''}`;
    change(s);
    const after = `${viewsJson(s)}|${runId ? JSON.stringify(s.runs.get(runId)?.run ?? null) : ''}`;
    if (before !== after) deps.onChange?.(bindingId);
  }

  function prune(s: Space, now: number): void {
    for (const [id, { run }] of s.runs) {
      const gone =
        run.endedAt !== null
          ? now - run.endedAt > RUN_KEPT_AFTER_END_MS
          : now - run.lastEventAt > RUN_SILENT_DROP_MS;
      if (gone) s.runs.delete(id);
    }
  }

  function markRefresh(s: Space, view: string, runId: string, startedBy: 'clock' | 'view', now: number): void {
    const work = s.views.get(view) ?? bareView(view);
    work.lastRefresh = { startedAt: now, finishedAt: null, startedBy, result: null };
    work.refreshingRunId = runId;
    work.skipped = null;
    s.views.set(view, work);
  }

  return {
    runStarted(run: {
      bindingId: string;
      runId: string;
      ownerUserId: string;
      agent: 'claude' | 'codex';
      startedBy: RunStartedBy;
      view: string | null;
    }): void {
      watching(run.bindingId, run.runId, (s) => {
        const now = deps.now();
        prune(s, now);
        s.runs.set(run.runId, {
          pending: new Set(),
          run: {
            runId: run.runId,
            startedBy: run.startedBy,
            view: run.view,
            ownerUserId: run.ownerUserId,
            agent: run.agent,
            startedAt: now,
            state: 'working',
            step: 'Starting',
            stepKind: 'starting',
            lastEventAt: now,
            endedAt: null,
          },
        });
        // Only the clock's own pass is a refresh here; a button pressed in the view is not, and
        // "Run now" says so itself through `refreshStarted`.
        if (run.view && run.startedBy === 'clock') markRefresh(s, run.view, run.runId, 'clock', now);
      });
    },

    /** The person started a view's pass themselves ("Run now"); its run is already known. */
    refreshStarted(bindingId: string, view: string, runId: string): void {
      watching(bindingId, runId, (s) => markRefresh(s, view, runId, 'view', deps.now()));
    },

    runEvent(bindingId: string, runId: string, event: { kind: string; payload: Record<string, unknown> }): void {
      if (!spaces.get(bindingId)?.runs.has(runId)) return;
      watching(bindingId, runId, (s) => {
        const held = s.runs.get(runId);
        if (!held) return;
        const { run, pending } = held;
        const now = deps.now();
        run.lastEventAt = now;
        const { kind, payload } = event;
        const setStep = (step: string, stepKind: RunStepKind) => {
          if (run.endedAt !== null) return;
          run.step = step;
          run.stepKind = stepKind;
        };
        if (kind === 'tool_call' || (kind === 'tool_call_update' && (typeof payload.kind === 'string' || typeof payload.title === 'string'))) {
          const { step, stepKind } = runStep(payload);
          setStep(step, stepKind);
        } else if (kind === 'agent_thought_chunk' || kind === 'plan') {
          setStep('Thinking', 'thinking');
        } else if (kind === 'agent_message_chunk') {
          setStep('Writing its reply', 'replying');
        } else if (kind === 'run_retried') {
          setStep('Starting again', 'starting');
        } else if (kind === 'permission_requested') {
          if (run.endedAt === null) {
            pending.add(String(payload.requestId));
            run.state = 'waiting';
          }
        } else if (kind === 'permission_decided') {
          pending.delete(String(payload.requestId));
          if (run.endedAt === null && pending.size === 0) run.state = 'working';
        } else if (kind === 'turn_ended') {
          const status = payload.status;
          run.state = status === 'done' || status === 'failed' || status === 'stopped' ? status : 'failed';
          run.endedAt = now;
          run.step = '';
          pending.clear();
          for (const work of s.views.values()) {
            if (work.refreshingRunId !== runId) continue;
            work.refreshingRunId = null;
            if (work.lastRefresh) {
              work.lastRefresh.finishedAt = now;
              work.lastRefresh.result = run.state === 'done' ? 'ok' : run.state === 'stopped' ? 'stopped' : 'failed';
            }
          }
        }
      });
    },

    viewsSeen(bindingId: string, who: string | null, views: SeenView[]): void {
      if (who !== null) me = who;
      watching(bindingId, null, (s) => {
        const now = deps.now();
        const next = new Map<string, ViewWork>();
        for (const seen of views) {
          const old = s.views.get(seen.name);
          const nextDueAt =
            seen.everyMs === null
              ? null
              : viewNextDueMs({ everyMs: seen.everyMs, dataModifiedMs: seen.dataModifiedMs, lastStartedMs: seen.lastStartedMs });
          next.set(seen.name, {
            view: seen.name,
            everyMs: seen.everyMs,
            runsAs: seen.runsAs,
            runsHere: me !== null && seen.runsAs !== null ? seen.runsAs === me : null,
            needsAccept: seen.needsAccept === true,
            dataModifiedMs: seen.dataModifiedMs,
            refreshingRunId: old?.refreshingRunId ?? null,
            lastRefresh: old?.lastRefresh ?? null,
            nextDueAt,
            skipped: old?.skipped && (nextDueAt === null || nextDueAt <= now) ? old.skipped : null,
          });
        }
        for (const [name, old] of s.views) {
          if (!next.has(name) && old.refreshingRunId !== null) next.set(name, old);
        }
        s.views = next;
      });
    },

    refreshSkipped(bindingId: string, view: string, reason: ViewRefreshSkip): void {
      watching(bindingId, null, (s) => {
        const work = s.views.get(view);
        if (work) work.skipped = { reason, at: deps.now() };
      });
    },

    refreshNotStarted(bindingId: string, view: string): void {
      watching(bindingId, null, (s) => {
        const work = s.views.get(view);
        if (!work) return;
        const now = deps.now();
        work.lastRefresh = { startedAt: now, finishedAt: now, startedBy: 'clock', result: 'not_started' };
      });
    },

    /** When Rig's own look over the space last started and ended, from the gardener's record. */
    checked(bindingId: string, check: SpaceCheck): void {
      const s = space(bindingId);
      if (JSON.stringify(s.check) === JSON.stringify(check)) return;
      s.check = { ...check };
      deps.onChange?.(bindingId);
    },

    /** Every space this Mac has looked at, for Home's list: which have standing work, and what is going. */
    all(): SpaceState[] {
      return [...spaces.keys()].map((bindingId) => this.get(bindingId));
    },

    get(bindingId: string): SpaceState {
      const now = deps.now();
      const s = spaces.get(bindingId);
      if (!s) return { bindingId, at: now, views: [], runs: [] };
      prune(s, now);
      const views = [...s.views.values()]
        .sort((a, b) => a.view.localeCompare(b.view))
        .map((v) => structuredClone(v));
      const runs = [...s.runs.values()]
        .map((h) => h.run)
        .sort((a, b) => {
          const activeA = a.endedAt === null ? 0 : 1;
          const activeB = b.endedAt === null ? 0 : 1;
          return activeA - activeB || b.startedAt - a.startedAt;
        })
        .slice(0, RUNS_KEPT)
        .map((r) => ({ ...r }));
      return s.check ? { bindingId, at: now, views, runs, check: { ...s.check } } : { bindingId, at: now, views, runs };
    },
  };
}
