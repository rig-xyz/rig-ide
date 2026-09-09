/**
 * Home's pure "what should this session's dot/subtext say" derivation —
 * given the facts `session-attention-store.ts` (chat feature) tracks for
 * one session, decide `'working' | 'unread' | 'idle'`. Kept side-effect
 * free and separate from that store on purpose: this is testable with
 * plain object literals, no registry/MobX involved.
 */
import type { SessionAttentionFacts } from '@renderer/features/chat/session-attention-store';

export type SessionAttentionStatus = 'working' | 'unread' | 'idle';

/**
 * `isWorking` always wins — a session mid-turn is never merely "unread."
 * Otherwise: new output landed (`lastOutputAt` set) that the user hasn't
 * seen since (`lastSeenAt` is null, or strictly older than that output) is
 * `'unread'`. Everything else — nothing recorded yet, or already seen at
 * or after the last output — is `'idle'`, today's plain rendering.
 */
export function deriveSessionAttentionStatus(facts: SessionAttentionFacts): SessionAttentionStatus {
  if (facts.isWorking) return 'working';
  if (facts.lastOutputAt !== null && (facts.lastSeenAt === null || facts.lastSeenAt < facts.lastOutputAt)) {
    return 'unread';
  }
  return 'idle';
}

const STATUS_RANK: Record<SessionAttentionStatus, number> = { idle: 0, unread: 1, working: 2 };

/**
 * The rig row's own dot (`rigs-rail.tsx`'s `LocalRigRow`) — the loudest
 * status among its sessions, so the row stays informative even when its
 * session sub-rows are capped (`SESSIONS_PER_RIG_CAP`) or simply absent.
 */
export function deriveRowAttentionStatus(
  sessionStatuses: readonly SessionAttentionStatus[]
): SessionAttentionStatus {
  let loudest: SessionAttentionStatus = 'idle';
  for (const status of sessionStatuses) {
    if (STATUS_RANK[status] > STATUS_RANK[loudest]) loudest = status;
  }
  return loudest;
}
