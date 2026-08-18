import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { db } from '@main/db/client';
import { rigRigs, rigSessionEvents, rigSessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type {
  RigRecentSession,
  RigSessionEventInput,
  RigSessionEventRecord,
  RigStoredSession,
} from '@shared/rig/sessions';

/**
 * `rig_sessions` / `rig_session_events` reads and writes
 * (`persistence-design.md` Round B).
 *
 * The writer lives on the RENDERER side of the transcript stream (worker →
 * renderer wire ports never pass through main — see `rig-chat-store.ts`),
 * so every write here is main answering a batched RPC call, not main
 * observing anything live itself. `at` is stamped here, once per batch —
 * "arrival at persistence, one clock" — and handed back in the ack so the
 * renderer never reaches for its own clock to show a time.
 */

const MAX_EVENTS_PER_SESSION = 200;

function toStoredSession(row: typeof rigSessions.$inferSelect): RigStoredSession {
  return {
    id: row.id,
    rigId: row.rigId,
    providerId: row.providerId,
    title: row.title,
    titleSource: row.titleSource === 'manual' ? 'manual' : 'auto',
    status: row.status === 'closed' ? 'closed' : 'active',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    acpSessionId: row.acpSessionId,
  };
}

async function resolveRigId(bindingId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: rigRigs.id })
    .from(rigRigs)
    .where(eq(rigRigs.bindingId, bindingId))
    .limit(1);
  return row?.id ?? null;
}

export const rigSessionsController = createRPCController({
  /**
   * Creates the session's row (or, on a resume, brings an existing one back
   * to `active` and refreshes its `acpSessionId`) — "rig_sessions row
   * created at session start." Requires a `rig_rigs` row for `bindingId` to
   * already exist (written by `workspace.detect` on every open, Round A);
   * if it doesn't, this is a no-op the caller logs rather than a crash.
   */
  ensureSession: async ({
    sessionId,
    bindingId,
    providerId,
    acpSessionId,
  }: {
    sessionId: string;
    bindingId: string;
    providerId: string;
    acpSessionId: string | null;
  }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const rigId = await resolveRigId(bindingId);
    if (!rigId) return { ok: false, reason: 'No rig_rigs row for this binding yet' };
    const now = Date.now();
    try {
      await db
        .insert(rigSessions)
        .values({
          id: sessionId,
          rigId,
          providerId,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          acpSessionId,
        })
        .onConflictDoUpdate({
          target: rigSessions.id,
          set: { acpSessionId, updatedAt: now, status: 'active' },
        });
      return { ok: true };
    } catch (error) {
      log.warn('rig sessions: failed to ensure session row', { sessionId, error: String(error) });
      return { ok: false, reason: 'write failed' };
    }
  },

  /**
   * First-prompt title, reused verbatim for the tab label and history rows —
   * the AUTO write path only. Server-side conditional on `title_source !=
   * 'manual'` (defense in depth, round S2+): a client that still thinks a
   * session is untitled — a stale in-memory store, a race with a rename from
   * elsewhere — can never clobber a title the user set by hand through this
   * call; it just silently no-ops. `rename` below is the one path that's
   * always allowed to write, since it's an explicit user action.
   */
  setTitle: async ({ sessionId, title }: { sessionId: string; title: string }): Promise<void> => {
    try {
      await db
        .update(rigSessions)
        .set({ title, updatedAt: Date.now() })
        .where(and(eq(rigSessions.id, sessionId), ne(rigSessions.titleSource, 'manual')));
    } catch (error) {
      log.warn('rig sessions: failed to set title', { sessionId, error: String(error) });
    }
  },

  /**
   * Explicit user rename (round S2+ — double-click a tab, or the History
   * list's rename affordance). Always writes, and marks `title_source`
   * `'manual'` — from this point on, `setTitle`'s auto-derivation above
   * never touches this row again.
   */
  rename: async ({ sessionId, title }: { sessionId: string; title: string }): Promise<void> => {
    try {
      await db
        .update(rigSessions)
        .set({ title, titleSource: 'manual', updatedAt: Date.now() })
        .where(eq(rigSessions.id, sessionId));
    } catch (error) {
      log.warn('rig sessions: failed to rename session', { sessionId, error: String(error) });
    }
  },

  /**
   * Batched, ordering-preserving append. `onConflictDoNothing` on
   * `(sessionId, seq)` makes a resend idempotent — a duplicate batch (e.g.
   * a retry racing an already-landed one) can never reorder events or
   * re-stamp one that already has an `at`. A write failure is logged and
   * the batch is dropped, never silently retried (which could reorder a
   * later, successful batch ahead of it).
   */
  appendEvents: async ({
    sessionId,
    events,
  }: {
    sessionId: string;
    events: RigSessionEventInput[];
  }): Promise<{ at: number }> => {
    const at = Date.now();
    if (events.length === 0) return { at };
    try {
      await db
        .insert(rigSessionEvents)
        .values(
          events.map((event) => ({
            sessionId,
            seq: event.seq,
            at,
            eventJson: JSON.stringify(event.turn),
          }))
        )
        .onConflictDoNothing();
      await db
        .update(rigSessions)
        .set({ updatedAt: at, status: 'active' })
        .where(eq(rigSessions.id, sessionId));
    } catch (error) {
      log.warn('rig sessions: dropped a batch of events (not retried)', {
        sessionId,
        seqs: events.map((e) => e.seq),
        error: String(error),
      });
    }
    return { at };
  },

  /** Wired to session close/stop — the final status transition for this row. */
  closeSession: async ({ sessionId }: { sessionId: string }): Promise<void> => {
    try {
      await db
        .update(rigSessions)
        .set({ status: 'closed', updatedAt: Date.now() })
        .where(eq(rigSessions.id, sessionId));
    } catch (error) {
      log.warn('rig sessions: failed to close session', { sessionId, error: String(error) });
    }
  },

  /** This rig's stored sessions, newest-touched first — the History list. */
  listSessions: async ({
    bindingId,
    limit = 20,
  }: {
    bindingId: string;
    limit?: number;
  }): Promise<RigStoredSession[]> => {
    const rigId = await resolveRigId(bindingId);
    if (!rigId) return [];
    const rows = await db
      .select()
      .from(rigSessions)
      .where(eq(rigSessions.rigId, rigId))
      .orderBy(desc(rigSessions.updatedAt))
      .limit(limit);
    return rows.map(toStoredSession);
  },

  /**
   * Recent sessions ACROSS every rig, newest-touched first — the home
   * screen's CONTINUE section (round H1). `listSessions` above is
   * deliberately scoped to one binding; this is its cross-rig counterpart,
   * with the owning rig's name/path/bindingId joined in so the renderer
   * never has to fan out a `getSession`-per-row follow-up just to label
   * where each one came from.
   */
  listRecentAcrossRigs: async ({
    limit = 5,
  }: { limit?: number } = {}): Promise<RigRecentSession[]> => {
    const rows = await db
      .select({
        id: rigSessions.id,
        providerId: rigSessions.providerId,
        title: rigSessions.title,
        updatedAt: rigSessions.updatedAt,
        rigBindingId: rigRigs.bindingId,
        rigName: rigRigs.name,
        rigPath: rigRigs.path,
      })
      .from(rigSessions)
      .innerJoin(rigRigs, eq(rigSessions.rigId, rigRigs.id))
      .orderBy(desc(rigSessions.updatedAt))
      .limit(limit);
    return rows;
  },

  /** One session's row — the replay header and the resume capability check need `acpSessionId`/`providerId`. */
  getSession: async ({ sessionId }: { sessionId: string }): Promise<RigStoredSession | null> => {
    const [row] = await db.select().from(rigSessions).where(eq(rigSessions.id, sessionId)).limit(1);
    return row ? toStoredSession(row) : null;
  },

  /** A session's committed turns in order, for replay or for resume-seeding. */
  getEvents: async ({ sessionId }: { sessionId: string }): Promise<RigSessionEventRecord[]> => {
    const rows = await db
      .select()
      .from(rigSessionEvents)
      .where(eq(rigSessionEvents.sessionId, sessionId))
      .orderBy(asc(rigSessionEvents.seq))
      .limit(MAX_EVENTS_PER_SESSION);
    const events: RigSessionEventRecord[] = [];
    for (const row of rows) {
      try {
        events.push({ seq: row.seq, at: row.at, turn: JSON.parse(row.eventJson) });
      } catch (error) {
        log.warn('rig sessions: dropped an unparsable stored event', {
          sessionId,
          seq: row.seq,
          error: String(error),
        });
      }
    }
    return events;
  },
});
