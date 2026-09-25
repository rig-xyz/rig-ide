/**
 * Doc-focus round: the pure state → tile decision for one agent's tile on
 * `SpaceRail` (the left rail that replaces the floating Room chip in doc
 * focus — see that component's own header comment). Sourced straight from
 * the live `RoomSnapshot` via `effectiveRunStatus`/`projectSessionCard` —
 * the same session-projection helpers `agent-rows.tsx`'s own
 * `spaceChipStatus` and `AgentRows` already use for "is this agent
 * working" — never a new backend call. Kept side-effect free and separate
 * from the component that reads it, same reasoning as `space-status-
 * state.ts` (home's own equivalent, over `RigSpaceStatus` instead of a
 * live snapshot's runs) — testable with plain object literals.
 */

import { effectiveRunStatus, projectSessionCard } from '../projection';
import type { DotMatrixEnd, DotMatrixState } from '@renderer/lib/ui/dot-matrix';
import type { RoomSnapshot, SessionRunMeta } from '../types';

/** Mirrors home's own `RECENT_ENDED_MS` (`features/home/space-status-state.ts`) — how long a just-ended run still gets its own end glyph before the tile settles back to quiet. */
export const RECENT_ENDED_MS = 15 * 60 * 1000;

export type AgentTileState =
  | { kind: 'live'; state: DotMatrixState }
  /** No live run and nothing recently ended — a still, dim tile (1b: "quiet spaces = a still, dim tile"). */
  | { kind: 'quiet' };

/**
 * One agent's own tile state, from its runs in this room (`owner`+`agent`
 * pair — a run belongs to whoever started it, same as `agent-rows.tsx`'s
 * own `runsOf`). A running turn always wins: waiting on YOUR approval
 * breathes (`waiting`), any other running turn gets a plain live motion
 * (`thinking` — the rail's tile is small enough that the exact per-step
 * motion `session-card.tsx` draws would be lost at this size; the tooltip
 * names the real state in words instead). Otherwise a recently-ended run's
 * own outcome glyph; otherwise quiet.
 */
export function deriveAgentTileState(runs: readonly SessionRunMeta[], snapshot: RoomSnapshot, now: number): AgentTileState {
  const latest = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  if (!latest) return { kind: 'quiet' };
  const card = projectSessionCard(snapshot.sessionEventsByRun[latest.id] ?? []);
  const status = effectiveRunStatus(latest.status, card);
  if (status === 'running') {
    const state: DotMatrixState = card.permissions.pending.length > 0 ? 'waiting' : 'thinking';
    return { kind: 'live', state };
  }
  if (latest.endedAt) {
    const endedAt = Date.parse(latest.endedAt);
    if (!Number.isNaN(endedAt) && now - endedAt <= RECENT_ENDED_MS) {
      const state: DotMatrixEnd = status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'stopped';
      return { kind: 'live', state };
    }
  }
  return { kind: 'quiet' };
}

/** In words, for the tile's tooltip — "Claude is waiting on you", "Claude thinking", "Claude finished", "Claude quiet". */
export function describeAgentTileState(state: AgentTileState, agentName: string): string {
  if (state.kind === 'quiet') return `${agentName} quiet`;
  switch (state.state) {
    case 'waiting':
      return `${agentName} is waiting on you`;
    case 'done':
      return `${agentName} finished`;
    case 'failed':
      return `${agentName} failed`;
    case 'stopped':
      return `${agentName} stopped`;
    default:
      return `${agentName} working`;
  }
}
