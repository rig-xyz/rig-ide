import { defineEvent } from '../lib/ipc/events';
import type { ViewAt } from './views';

/**
 * What this Mac's Rig knows about a space's standing work and turns (spike, Rig Alpha). Plain JSON
 * on purpose: the renderer reads it over IPC today and an orchestrator tool will read the same
 * object later. Written only by the main process (`main/rig/space-state`).
 */
export type RunStartedBy = 'message' | 'view' | 'clock' | 'gardener' | 'comment';
export type RunStepKind =
  | 'starting'
  | 'thinking'
  | 'reading'
  | 'writing'
  | 'searching'
  | 'running'
  | 'tool'
  | 'replying';
export type SpaceRun = {
  runId: string;
  startedBy: RunStartedBy;
  /** The view whose action or schedule started it; null otherwise. */
  view: string | null;
  ownerUserId: string;
  agent: 'claude' | 'codex';
  startedAt: number;
  state: 'working' | 'waiting' | 'done' | 'failed' | 'stopped';
  /** What it is doing now, in plain words; '' once ended. */
  step: string;
  stepKind: RunStepKind;
  lastEventAt: number;
  endedAt: number | null;
};
export type ViewRefreshSkip = 'busy' | 'queued';
export type ViewWork = {
  view: string;
  everyMs: number | null; // null: refreshes only when asked
  /** The set time it runs at ("every Friday at 15:00"), when its schedule is one. Absent or null: an interval. */
  at?: ViewAt | null;
  runsAs: string | null; // usr_… from view.json
  runsHere: boolean | null; // null: who is signed in is not known yet
  /** It would run here, but this Mac's person has not agreed to this schedule (someone else set or changed it). */
  needsAccept: boolean;
  dataModifiedMs: number | null;
  refreshingRunId: string | null;
  lastRefresh: {
    startedAt: number;
    finishedAt: number | null;
    startedBy: 'clock' | 'view';
    result: 'ok' | 'failed' | 'stopped' | 'not_started' | null;
  } | null;
  nextDueAt: number | null; // 0 means due now; null when everyMs is null
  skipped: { reason: ViewRefreshSkip; at: number } | null;
};
/** Rig's own regular look over the space (the gardener), as this Mac last ran it. */
export type SpaceCheck = { lastStartedAt: number | null; lastFinishedAt: number | null };
export type SpaceState = {
  bindingId: string;
  at: number;
  views: ViewWork[];
  runs: SpaceRun[];
  /** Absent when this Mac has never looked the space over (only the owner's app does). */
  check?: SpaceCheck;
};
export const rigSpaceStateChannel = defineEvent<SpaceState>('rig:space-state');
