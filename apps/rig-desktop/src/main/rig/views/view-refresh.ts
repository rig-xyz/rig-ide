import type { SeenView } from '../space-state/space-state';
import {
  isViewRefreshDue,
  parseViewSchedule,
  viewRefreshPrompt,
  viewScheduleSignature,
  viewTurnContext,
  type ViewSchedule,
} from '@shared/rig/views';

/**
 * Rig views that keep themselves fresh (spike, Rig Alpha). A view's `view.json`, written by the
 * agent that made it, may say how old its data may get and whose session refreshes it. This is
 * only the timer: when a view is due, a turn starts in that member's own session in the space,
 * like any other turn, and the session decides what a refresh means under the space's rules.
 *
 * The interval counts from the last pass this app started (`lastStarted`, kept on disk by the real
 * wiring), so a button pressed in the view, which rewrites the data file, never puts the pass off.
 * The data file's age only stands in while no pass is on record.
 * It runs only in the app signed in as the view's `runs_as` member, and never on top of a turn
 * that session is already in.
 *
 * `views/` syncs like any other file, so another member (or their agent) can write this person's
 * id into `runs_as`, or change the words of a schedule that already runs. Nothing starts in a
 * person's session on words they did not agree to: this app remembers, per view, the schedule its
 * person agreed to (`consent`, kept on this Mac, never synced). A schedule is agreed to when this
 * Mac's own session wrote it (`wroteHere`), when the person accepts it or presses "Run now"
 * (`accept`), or, once, when this app was already running it before it kept such a record (the
 * first full pass after the update; from then on a schedule put on a view it ran before waits like
 * any other). Any other schedule waits, and the space's state says so (`needsAccept`).
 *
 * Pure apart from the injected deps, so it is unit-tested under `node`; the real wiring is
 * `wireViewRefresh` in `spaces/dispatch-controller-instance.ts`.
 */
export type ViewRefreshDeps = {
  /** Rig Alpha is on and spaces are running. */
  enabled: () => boolean;
  /** The signed-in member's relay user id, or null when signed out or offline. */
  me: () => Promise<string | null>;
  /** Every space with a folder on this Mac. */
  spaces: () => Promise<{ bindingId: string; path: string }[]>;
  /** The views in a space folder, with each one's `view.json` text and when its data last changed. */
  views: (
    path: string
  ) => Promise<{ name: string; meta: string | null; dataModifiedMs: number | null }[]>;
  /** That member's session in the space is in a turn right now. */
  busy: (bindingId: string, userId: string) => boolean;
  /** Starts the turn; false when it could not start. */
  run: (spec: {
    bindingId: string;
    userId: string;
    view: string;
    prompt: string;
    context: string;
  }) => Promise<boolean>;
  now: () => number;
  /** Every view the timer looked at in a space, with its schedule and last try: for the space's state, never for deciding. */
  seen?: (bindingId: string, userId: string, views: SeenView[]) => void;
  /** A view was due but its refresh did not start: its session is in a turn ('busy') or a view before it took this tick ('queued'). */
  skipped?: (bindingId: string, view: string, reason: 'busy' | 'queued') => void;
  /** `run` said the turn could not start. */
  notStarted?: (bindingId: string, view: string) => void;
  /** When this app last started each view's pass, by `bindingId/view`. In memory when not given. */
  lastStarted?: { get(key: string): number | undefined; set(key: string, at: number): void };
  /** The schedule this Mac's person agreed to for each view (`viewScheduleSignature`), by `bindingId/view`. In memory when not given. */
  consent?: { get(key: string): string | undefined; set(key: string, signature: string): void };
  /** This Mac's own session wrote this view's `view.json` a moment ago. Without it, only `accept` agrees to a new schedule. */
  wroteHere?: (bindingId: string, view: string, signature: string) => boolean;
};

export const VIEW_REFRESH_TICK_MS = 60_000;
/** Set in the consent record once this app has made its first full pass: schedules it ran before that are kept, later ones are asked about. Not a view key (those hold a `/`). */
const CONSENT_KEPT_SINCE = '#kept-since';

export function createViewRefresher(deps: ViewRefreshDeps) {
  const lastStarted = deps.lastStarted ?? new Map<string, number>();
  const consent = deps.consent ?? new Map<string, string>();
  let ticking = false;
  let lastMe: string | null = null;

  /**
   * Whether this Mac's person has agreed to the schedule as it stands. Agrees on the spot when
   * their own session just wrote it, or when this app ran the view before it kept any record.
   */
  function agreed(bindingId: string, view: string, schedule: ViewSchedule): boolean {
    const key = `${bindingId}/${view}`;
    const signature = viewScheduleSignature(schedule);
    const on = consent.get(key);
    if (on === signature) return true;
    const ranBefore =
      on === undefined &&
      consent.get(CONSENT_KEPT_SINCE) === undefined &&
      lastStarted.get(key) !== undefined;
    if (ranBefore || deps.wroteHere?.(bindingId, view, signature) === true) {
      consent.set(key, signature);
      return true;
    }
    return false;
  }

  /** Reads a space's views and tells `seen` about each, with the schedule parsed once. */
  async function read(space: { bindingId: string; path: string }, userId: string) {
    const listed = await deps.views(space.path);
    const parsed = listed.map((view) => {
      const schedule = view.meta ? parseViewSchedule(view.meta) : null;
      const mine = schedule !== null && schedule.runsAs === userId;
      return { view, schedule, accepted: mine && agreed(space.bindingId, view.name, schedule) };
    });
    deps.seen?.(
      space.bindingId,
      userId,
      parsed.map(({ view, schedule, accepted }) => ({
        name: view.name,
        everyMs: schedule?.everyMs ?? null,
        runsAs: schedule?.runsAs ?? null,
        dataModifiedMs: view.dataModifiedMs,
        lastStartedMs: lastStarted.get(`${space.bindingId}/${view.name}`) ?? null,
        needsAccept: schedule !== null && schedule.runsAs === userId && !accepted,
      }))
    );
    return parsed;
  }

  return {
    /** Looks once at every space on this Mac and starts at most one refresh in each. */
    async tick(): Promise<string[]> {
      if (ticking || !deps.enabled()) return [];
      ticking = true;
      const started: string[] = [];
      try {
        const userId = await deps.me();
        if (!userId) return started;
        lastMe = userId;
        for (const space of await deps.spaces()) {
          const busy = deps.busy(space.bindingId, userId);
          let startedHere = false;
          for (const { view, schedule, accepted } of await read(space, userId)) {
            if (!schedule || schedule.runsAs !== userId) continue;
            // Someone else set or changed it: it waits for this Mac's person to agree.
            if (!accepted) continue;
            const key = `${space.bindingId}/${view.name}`;
            const now = deps.now();
            const due = isViewRefreshDue({
              everyMs: schedule.everyMs,
              dataModifiedMs: view.dataModifiedMs,
              lastStartedMs: lastStarted.get(key) ?? null,
              now,
            });
            if (!due) continue;
            if (busy) {
              deps.skipped?.(space.bindingId, view.name, 'busy');
              continue;
            }
            if (startedHere) {
              // One turn per space per tick: the next view waits for this one to finish.
              deps.skipped?.(space.bindingId, view.name, 'queued');
              continue;
            }
            startedHere = true;
            lastStarted.set(key, now);
            const ok = await deps.run({
              bindingId: space.bindingId,
              userId,
              view: view.name,
              prompt: viewRefreshPrompt(view.name, schedule),
              context: viewTurnContext(view.name),
            });
            if (ok) started.push(key);
            else deps.notStarted?.(space.bindingId, view.name);
          }
        }
        // Every space has been looked at once: what ran before this record existed is now in it.
        if (consent.get(CONSENT_KEPT_SINCE) === undefined) {
          consent.set(CONSENT_KEPT_SINCE, String(deps.now()));
        }
      } finally {
        ticking = false;
      }
      return started;
    },

    /** A pass the person started themselves ("Run now") counts like one the clock started. */
    started(bindingId: string, view: string): void {
      lastStarted.set(`${bindingId}/${view}`, deps.now());
    },

    /** This Mac's person agrees to a view's schedule as it stands: by accepting it, or by running it themselves. */
    accept(bindingId: string, view: string, schedule: Pick<ViewSchedule, 'everyMs' | 'refresh'>): void {
      consent.set(`${bindingId}/${view}`, viewScheduleSignature(schedule));
    },

    /** Reports a space's views to `seen` now (when its state is asked for). Never starts anything. */
    async look(space: { bindingId: string; path: string }): Promise<void> {
      const userId = lastMe ?? (await deps.me());
      if (!userId) return;
      await read(space, userId);
    },
  };
}

/**
 * Keeps a view from flooding its member's session: the same choice sent twice in a row is one
 * choice, and a view gets a handful of turns a minute however many times its page calls `rig.act`.
 */
export function createViewActLimit(limits = { repeatMs: 10_000, perMinute: 6 }) {
  const lastSame = new Map<string, number>();
  const recent = new Map<string, number[]>();
  return {
    /**
     * 'repeat' when this exact choice was just sent (it is already on its way: nothing to do or say),
     * 'flood' when the view has started too many turns, null when it may start one (and is counted).
     */
    refuse(
      spec: { bindingId: string; view: string; intent: string; payload: Record<string, string> },
      now: number
    ): 'repeat' | 'flood' | null {
      const viewKey = `${spec.bindingId}/${spec.view}`;
      const sameKey = `${viewKey}/${spec.intent}/${JSON.stringify(spec.payload)}`;
      const last = lastSame.get(sameKey);
      if (last !== undefined && now - last < limits.repeatMs) return 'repeat';
      const times = (recent.get(viewKey) ?? []).filter((t) => now - t < 60_000);
      if (times.length >= limits.perMinute) return 'flood';
      times.push(now);
      recent.set(viewKey, times);
      lastSame.set(sameKey, now);
      return null;
    },
  };
}
