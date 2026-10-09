import type { AgentKind, RoomMessage } from './types';

/**
 * How long an ask shows as waiting. A Mac that's on claims within a poll,
 * and a request no Mac of yours can run is failed after two minutes
 * (`request-claim.ts`), so an ask still open after this is stale history:
 * an older app that never linked its failure, or a request that was never
 * filed.
 */
export const PENDING_ASK_WINDOW_MS = 10 * 60_000;

/**
 * The agent a message asked (`meta.asks`) that hasn't started on it yet:
 * no run names it as its source, and its author has had no agent failure
 * since. Null once started, failed, too old, or for a message that asked
 * no agent. `messages` is the Room in seq order.
 */
export function waitingAgentFor(
  message: RoomMessage,
  messages: readonly RoomMessage[],
  now: number
): AgentKind | null {
  if (message.meta.kind !== 'text' || !message.meta.asks) return null;
  const created = Date.parse(message.createdAt);
  if (Number.isFinite(created) && now - created > PENDING_ASK_WINDOW_MS) return null;
  for (const other of messages) {
    if (other.meta.kind === 'session' && other.meta.sourceMessageId === message.id) return null;
    // A failure line carries no link to its ask; one from the same person
    // after it settles it (their Mac posts it for their own request).
    if (
      other.meta.kind === 'system' &&
      other.meta.event === 'agent_failed' &&
      other.authorId === message.authorId &&
      other.seq > message.seq
    ) {
      return null;
    }
  }
  return message.meta.asks;
}
