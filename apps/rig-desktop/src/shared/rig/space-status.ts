/**
 * Home's per-space live status — the wire shape for `GET /v1/me/spaces/status`
 * (tap `packages/relay/src/routes/space-status.ts`), shared by the main-process
 * relay client (`main/rig/space-status.ts`) and the Home spaces card. One
 * entry per space binding the caller is a member of: what's running right
 * now (with a derived `activity` for the space row's `DotMatrix`), and —
 * once quiet — the most recently ended run, plus the newest few room
 * messages so Home can tell what's new since you last opened the space.
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
  /** The owner's display name, from the space's member list (the relay sends only the id); absent when unknown. */
  ownerName?: string;
};

export type RigSpaceLastRun = {
  status: 'done' | 'stopped' | 'failed';
  endedAt: string | null;
  agent: RigSpaceAgent;
  ownerUserId: string;
  /** As on `RigSpaceRunningItem`. */
  ownerName?: string;
};

/** One room message, just enough to count it: its `seq` compares against the Room's own read marker. */
export type RigSpaceRecentMessage = {
  id: string;
  seq: number;
  createdAt: string;
  /** The relay's `users.id` (same id space as `RigSpaceRunningItem.ownerUserId`). */
  authorUserId: string;
  /** A share-link guest's comment is stamped with the link creator's `authorUserId`, so this is what tells it apart. */
  authorKind: 'user' | 'agent' | 'guest';
};

export type RigSpaceStatus = {
  bindingId: string;
  running: RigSpaceRunningItem[];
  /** Only present when `running` is empty — a space with something live has no honest "last run" subtext to show instead. */
  lastRun?: RigSpaceLastRun;
  /** The newest ≤ 9 room messages (people's chat, doc comments, agent turns — no join/invite notices), oldest first. Absent from a relay that predates it. */
  recentMessages?: RigSpaceRecentMessage[];
};

export type RigSpaceStatusError =
  | { kind: 'notSignedIn'; message: string }
  | { kind: 'untrustedRelay'; host: string; message: string }
  | { kind: 'relay'; status?: number; message: string };
