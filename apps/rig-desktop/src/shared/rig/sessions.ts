/**
 * Session persistence contract (`persistence-design.md` Round B), shared by
 * the main-process store (`main/rig/sessions.ts`) and the renderer's
 * `RigChatStore`/history UI.
 *
 * A stored session's events are kept opaque here (`unknown`, JSON on the
 * wire) — main never depends on `@emdash/core/acp/client`'s `TranscriptTurn`
 * shape; that type belongs to the renderer, which is the only side that
 * ever constructs or reads one for real.
 */

/**
 * 'auto' — the write path's own first-prompt derivation may keep updating
 * `title`. 'manual' — the user renamed it; auto-titling must never
 * overwrite it again (round S2+, `session-writer.ts`'s `shouldPersistTitle`
 * and `main/rig/sessions.ts`'s `setTitle`, which is server-side conditional
 * on this too — defense in depth, not just a client-side check).
 */
export type RigSessionTitleSource = 'auto' | 'manual';

/** One persisted `rig_sessions` row — a session that has been (or is being) recorded. */
export type RigStoredSession = {
  id: string;
  rigId: string;
  providerId: string;
  title: string | null;
  titleSource: RigSessionTitleSource;
  status: 'active' | 'closed';
  createdAt: number;
  updatedAt: number;
  /** The ACP agent's own session id, once the runtime has returned one — null until then. */
  acpSessionId: string | null;
};

/** One client-batched event: a committed turn, keyed by the turn's own stable `seq`. */
export type RigSessionEventInput = {
  seq: number;
  /** Opaque to main — a `TranscriptTurn`, serialized as-is. */
  turn: unknown;
};

/** A stored event as read back for replay — `at` is main's honest write-time stamp. */
export type RigSessionEventRecord = {
  seq: number;
  at: number;
  turn: unknown;
};

/**
 * One `rig_sessions` row joined to its owning `rig_rigs` row — the shape the
 * home screen's CONTINUE section needs (round H1): a session on its own
 * doesn't say which rig it belongs to or what that rig is called, and
 * `listSessions` is scoped to a single binding, so a cross-rig "recent
 * sessions" read needs the join baked in rather than N+1 round trips from
 * the renderer.
 */
export type RigRecentSession = {
  id: string;
  providerId: string;
  title: string | null;
  updatedAt: number;
  rigBindingId: string;
  rigName: string | null;
  rigPath: string;
};
