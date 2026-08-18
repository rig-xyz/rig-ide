import { transcriptTurnSchema, type TranscriptTurn } from '@emdash/core/acp/client';
import type { RigSessionEventRecord, RigSessionTitleSource } from '@shared/rig/sessions';

/**
 * Pure batching logic for the session-persistence writer (`persistence-design.md`
 * Round B). Lives beside `rig-chat-store.ts`, which is the only IO caller.
 *
 * The writer's actual trigger is `RigChatStore._refreshHistory()` — every
 * time a turn commits, the runtime hands back its full current
 * `TranscriptTurn[]` (not a per-token stream; see that file). This module
 * answers "which of these are new since we last persisted" so the RPC call
 * only ever carries the delta, batched, in `turn.seq` order.
 */

export type SeqCarrier = { seq: number };

/** Turns not yet persisted, in ascending seq order. `lastSeq` is exclusive. */
export function newTurnsSince<T extends SeqCarrier>(turns: readonly T[], lastSeq: number): T[] {
  return turns.filter((turn) => turn.seq > lastSeq).sort((a, b) => a.seq - b.seq);
}

/** The next `lastSeq` watermark after persisting `appended` — the max of the two, never regresses. */
export function nextLastSeq(current: number, appended: readonly SeqCarrier[]): number {
  return appended.reduce((max, turn) => Math.max(max, turn.seq), current);
}

/**
 * Whether the just-derived title should be persisted — "title updated when
 * the first prompt lands." True exactly once per session: the moment
 * `previousTitle` transitions from unset to a real value. A resumed session
 * seeded with its stored title (`RigChatStore`'s `resume` constructor
 * param) never re-persists it via this path, since `previousTitle` is
 * already non-null by the time the first prompt is sent.
 *
 * Round S2+: `titleSource` is a second, independent veto — a manually-set
 * title (the tab-strip/History rename affordance) must never be
 * auto-derived over again, REGARDLESS of the null-check above. This is the
 * client-side half of the never-clobber rule (skips the round trip
 * entirely once the store already knows locally); `main/rig/sessions.ts`'s
 * `setTitle` enforces the same rule server-side too, so a stale/racing
 * client can't clobber a manual title even if this check is somehow wrong.
 * Defaults to `'auto'` so every pre-existing call site (all client-derived
 * titles, before this round) keeps behaving exactly as before.
 */
export function shouldPersistTitle(
  previousTitle: string | null,
  nextTitle: string | null,
  titleSource: RigSessionTitleSource = 'auto'
): boolean {
  if (titleSource === 'manual') return false;
  return previousTitle === null && nextTitle !== null;
}

/**
 * Stamps the write-time `at` onto each turn's first user-authored message —
 * the one place the timestamps UI reads from (`UserMessageCard`'s
 * hover-reveal badge; see `packages/chat-ui/src/model.ts`'s `ChatMessage.at`
 * and its doc comment). Every turn in this app opens with a user message
 * (the only way one is ever created here is `submitPrompt`/`startSession`),
 * so this always finds a target when one exists.
 *
 * A turn with no known `at` yet — not yet round-tripped through
 * `appendEvents`, e.g. the very first render right after it committed — is
 * left untouched: no timestamp shows, which is itself honest, not a bug.
 *
 * Deliberately does not touch `@emdash/core/acp/client`'s `TranscriptItem`
 * schema — `at` rides along as an extra property through the same
 * type-erasing cast `chat-ui`'s `flatten.ts` already performs
 * (`turn.items as readonly ChatItem[]`), read only by chat-ui's own
 * additive `ChatMessage.at` field.
 */
export function withTurnTimestamps(
  turns: readonly TranscriptTurn[],
  atBySeq: ReadonlyMap<number, number>
): TranscriptTurn[] {
  return turns.map((turn) => {
    const at = atBySeq.get(turn.seq);
    if (at === undefined) return turn;
    const items = turn.items.map((item) =>
      item.kind === 'message' && item.role === 'user' ? ({ ...item, at } as typeof item) : item
    );
    return { ...turn, items };
  });
}

export type StoredTurns = { turns: TranscriptTurn[]; atBySeq: Map<number, number> };

/**
 * Turns a `getEvents` read back into what `RigChatStore` needs to seed
 * replay/resume: real `TranscriptTurn[]` plus the seq→at map
 * `withTurnTimestamps` reads from. Parse-tolerant — a record whose stored
 * JSON no longer matches the current `TranscriptTurn` schema (an app
 * version drift) is dropped rather than crashing the whole read, the same
 * "corrupt data degrades gracefully" rule every other local cache in this
 * app follows.
 */
export function parseStoredEvents(records: readonly RigSessionEventRecord[]): StoredTurns {
  const turns: TranscriptTurn[] = [];
  const atBySeq = new Map<number, number>();
  for (const record of records) {
    const parsed = transcriptTurnSchema.safeParse(record.turn);
    if (!parsed.success) continue;
    turns.push(parsed.data);
    atBySeq.set(record.seq, record.at);
  }
  return { turns, atBySeq };
}
