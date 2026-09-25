/**
 * Home's per-space live status — the wire shape for `GET /v1/me/spaces/status`
 * (tap `packages/relay/src/routes/space-status.ts`), shared by the main-process
 * relay client (`main/rig/space-status.ts`) and the Home spaces card. One
 * entry per space binding the caller is a member of: what's running right
 * now (with a derived `activity` for the space row's `DotMatrix`), and —
 * once quiet — the most recently ended run.
 */

/** Mirrors `renderer/lib/ui/dot-matrix.tsx`'s `DotMatrixActivity` (this module has no dependency on it, to keep `shared/` free of renderer-only code). */
export type RigSpaceActivity =
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running'
  | 'planning'
  | 'waiting';

export type RigSpaceAgent = 'claude' | 'codex';

export type RigSpaceRunningItem = {
  runId: string;
  agent: RigSpaceAgent;
  ownerUserId: string;
  startedAt: string;
  /** Derived from the run's latest logged event; `null` when nothing honest can be said yet. */
  activity: RigSpaceActivity | null;
  /** The latest tool call's (or pending permission's) own title, when the event carried one. */
  title?: string;
};

export type RigSpaceLastRun = {
  status: 'done' | 'stopped' | 'failed';
  endedAt: string | null;
  agent: RigSpaceAgent;
  ownerUserId: string;
};

export type RigSpaceStatus = {
  bindingId: string;
  running: RigSpaceRunningItem[];
  /** Only present when `running` is empty — a space with something live has no honest "last run" subtext to show instead. */
  lastRun?: RigSpaceLastRun;
};

export type RigSpaceStatusError =
  | { kind: 'notSignedIn'; message: string }
  | { kind: 'untrustedRelay'; host: string; message: string }
  | { kind: 'relay'; status?: number; message: string };
