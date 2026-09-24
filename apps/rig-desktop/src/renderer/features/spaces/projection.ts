/**
 * Spaces (lane 2): the session card projection — a pure reducer over a
 * run's event log. Ported from the spike at `tap-spike-sessions/packages/
 * relay/spikes/session-log/lib.ts` (`newCard`/`applyEvent`/`lineDiffStats`)
 * and hardened for this app:
 *
 *  - never throws on a malformed/partial payload (spike code assumed
 *    well-formed wire events with `as` casts everywhere; this version
 *    guards every field read)
 *  - understands the fixture-only `truncated`/`originalBytes` fields on
 *    `SessionEvent` (see `types.ts`) — a truncated diff still produces an
 *    output row, just always marked `approximate`
 *  - takes a plain `SessionEvent[]` rather than subscribing over SSE; the
 *    incremental-vs-from-scratch equivalence the spike's reconnect test
 *    checked by deep-equalling two live cards is instead a property test
 *    in `projection.test.ts`
 *
 * `projectSessionCard` folds a full event list into a `SessionCard` from
 * scratch. `applySessionEvent` is the single-event reducer it's built on —
 * exported too, so a room source can apply events incrementally as they
 * arrive without re-folding the whole log every time.
 */

import type {
  SessionCard,
  SessionEvent,
  SessionOutput,
  SessionStatus,
  SessionStep,
} from './types';

/** Internal-only bookkeeping carried alongside the public `SessionCard` shape while folding. */
interface CardState extends SessionCard {
  /** The messageId of the agent_message_chunk run currently being accumulated into `finalAnswer` — a new messageId resets the buffer instead of appending to the previous one. */
  _lastMessageId?: string;
}

export function newSessionCard(): SessionCard {
  return {
    status: 'running',
    currentStep: null,
    outputs: [],
    steps: [],
    finalAnswer: '',
    plan: [],
    thinking: '',
    usage: null,
    permissions: { pending: [], decided: [] },
    lastSeq: 0,
    model: null,
    failureReason: null,
  };
}

/** Cheap line-count diff: real LCS for small texts, length-delta fallback above a size guard. Never throws. */
export function lineDiffStats(
  oldText: string | null | undefined,
  newText: string
): { adds: number; dels: number; approximate: boolean } {
  const safeNew = typeof newText === 'string' ? newText : '';
  if (oldText == null) {
    const newLines = safeNew.length === 0 ? [] : safeNew.split('\n');
    return { adds: newLines.length, dels: 0, approximate: false };
  }
  const oldLines = oldText.split('\n');
  const newLines = safeNew.split('\n');
  if (oldLines.length * newLines.length > 250_000) {
    const delta = newLines.length - oldLines.length;
    return { adds: Math.max(0, delta), dels: Math.max(0, -delta), approximate: true };
  }
  const n = oldLines.length;
  const m = newLines.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let adds = 0;
  let dels = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      dels++;
      i++;
    } else {
      adds++;
      j++;
    }
  }
  dels += n - i;
  adds += m - j;
  return { adds, dels, approximate: false };
}

function findStep(card: CardState, toolCallId: string): SessionStep | undefined {
  return card.steps.find((s) => s.toolCallId === toolCallId);
}

function upsertOutput(
  card: CardState,
  path: string,
  oldText: string | null | undefined,
  newText: string,
  forceApproximate: boolean
): void {
  const { adds, dels, approximate } = lineDiffStats(oldText, newText);
  const isApproximate = approximate || forceApproximate;
  const existing = card.outputs.find((o) => o.path === path);
  if (existing) {
    existing.adds += adds;
    existing.dels += dels;
    existing.approximate = existing.approximate || isApproximate;
  } else {
    const output: SessionOutput = { path, adds, dels, approximate: isApproximate };
    card.outputs.push(output);
  }
}

function recordEditOutputs(card: CardState, payload: Record<string, unknown>, truncated: boolean): void {
  const content = payload.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'diff') continue;
    const path = typeof b.path === 'string' ? b.path : null;
    if (!path) continue;
    const oldText = typeof b.oldText === 'string' ? b.oldText : null;
    const newText = typeof b.newText === 'string' ? b.newText : '';
    upsertOutput(card, path, oldText, newText, truncated);
  }
}

const VALID_STATUSES: readonly SessionStatus[] = ['running', 'waiting', 'done', 'stopped', 'failed'];

/**
 * Applies ONE session event to a card in place. Used both by
 * `projectSessionCard` (folding a full log) and by anything that wants to
 * apply events incrementally as they stream in — the two must agree, which
 * is exactly what `projection.test.ts` checks against the real fixtures.
 */
export function applySessionEvent(card: SessionCard, event: SessionEvent): void {
  const state = card as CardState;
  state.lastSeq = Math.max(state.lastSeq, event.seq);
  const p = event.payload ?? {};
  const truncated = event.truncated === true;

  // The relay coalesces a run of adjacent same-kind chunk events into one
  // stored event, `{chunks: [payload, ...]}`; replay them one by one.
  if (Array.isArray(p.chunks)) {
    for (const chunk of p.chunks) {
      if (chunk && typeof chunk === 'object') {
        applySessionEvent(card, { ...event, payload: chunk as Record<string, unknown> });
      }
    }
    return;
  }

  switch (event.kind) {
    case 'agent_message_chunk': {
      const content = p.content as { type?: string; text?: string } | undefined;
      if (content && content.type === 'text' && typeof content.text === 'string') {
        const messageId = typeof p.messageId === 'string' ? p.messageId : '';
        if (state._lastMessageId !== messageId) {
          state.finalAnswer = '';
          state._lastMessageId = messageId;
        }
        state.finalAnswer += content.text;
      }
      break;
    }
    case 'tool_call': {
      const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : '';
      if (!toolCallId) break;
      const step: SessionStep = {
        toolCallId,
        kind: typeof p.kind === 'string' ? p.kind : undefined,
        title: typeof p.title === 'string' ? p.title : undefined,
        status: typeof p.status === 'string' ? p.status : 'pending',
        locations: Array.isArray(p.locations) ? (p.locations as SessionStep['locations']) : undefined,
      };
      state.steps.push(step);
      state.currentStep = { toolCallId, title: step.title, kind: step.kind };
      recordEditOutputs(state, p, truncated);
      break;
    }
    case 'tool_call_update': {
      const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : '';
      const step = toolCallId ? findStep(state, toolCallId) : undefined;
      if (step) {
        if (typeof p.kind === 'string') step.kind = p.kind;
        if (typeof p.title === 'string') step.title = p.title;
        if (typeof p.status === 'string') step.status = p.status;
        if (Array.isArray(p.locations)) step.locations = p.locations as SessionStep['locations'];
        state.currentStep = { toolCallId, title: step.title, kind: step.kind };
      }
      recordEditOutputs(state, p, truncated);
      break;
    }
    case 'permission_requested': {
      const toolCall = p.toolCall as Record<string, unknown> | undefined;
      const toolCallId = typeof toolCall?.toolCallId === 'string' ? toolCall.toolCallId : '';
      const requestId = typeof p.requestId === 'string' ? p.requestId : toolCallId;
      const requestedAt = typeof p.pubTs === 'number' ? p.pubTs : Date.now();
      const options = Array.isArray(p.options)
        ? p.options.flatMap((o: unknown) => {
            const opt = o as Record<string, unknown> | null;
            return opt && typeof opt.optionId === 'string'
              ? [
                  {
                    optionId: opt.optionId,
                    name: typeof opt.name === 'string' ? opt.name : opt.optionId,
                    kind: typeof opt.kind === 'string' ? opt.kind : '',
                  },
                ]
              : [];
          })
        : [];
      state.permissions.pending.push({
        requestId,
        toolCallId,
        title: typeof toolCall?.title === 'string' ? toolCall.title : toolCallId,
        options,
        requestedAt,
      });
      break;
    }
    case 'permission_decided': {
      const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : '';
      const requestId = typeof p.requestId === 'string' ? p.requestId : toolCallId;
      const asked = state.permissions.pending.find((x) => x.requestId === requestId);
      const optionId = typeof p.optionId === 'string' ? p.optionId : '';
      state.permissions.pending = state.permissions.pending.filter((x) => x.requestId !== requestId);
      state.permissions.decided.push({
        requestId,
        toolCallId,
        optionId,
        outcome: typeof p.outcome === 'string' ? p.outcome : '',
        optionKind: asked?.options.find((o) => o.optionId === optionId)?.kind,
        title: asked?.title,
        decidedAt: typeof p.pubTs === 'number' ? p.pubTs : undefined,
      });
      break;
    }
    case 'agent_thought_chunk': {
      const content = p.content as { type?: string; text?: string } | undefined;
      if (content && content.type === 'text' && typeof content.text === 'string') state.thinking += content.text;
      break;
    }
    case 'plan': {
      if (!Array.isArray(p.entries)) break;
      state.plan = p.entries.flatMap((raw: unknown) => {
        const entry = raw as Record<string, unknown> | null;
        if (!entry || typeof entry.content !== 'string') return [];
        const status =
          entry.status === 'completed' || entry.status === 'in_progress' ? entry.status : ('pending' as const);
        return [{ content: entry.content, status }];
      });
      break;
    }
    case 'usage_update': {
      const used = typeof p.used === 'number' ? p.used : null;
      const size = typeof p.size === 'number' ? p.size : null;
      if (used === null || size === null || size <= 0) break;
      const cost = p.cost as { amount?: unknown; currency?: unknown } | undefined;
      const costUsd =
        cost && typeof cost.amount === 'number' && cost.currency === 'USD' ? cost.amount : (state.usage?.costUsd ?? null);
      state.usage = { used, size, costUsd };
      break;
    }
    case 'run_model': {
      if (typeof p.model === 'string' && p.model) state.model = p.model;
      break;
    }
    case 'turn_ended': {
      // The live dispatcher records the run's final `status`; recorded
      // fixtures only carry an ACP `stopReason`.
      const stopReason = typeof p.stopReason === 'string' ? p.stopReason : '';
      const status: SessionStatus =
        typeof p.status === 'string' && VALID_STATUSES.includes(p.status as SessionStatus)
          ? (p.status as SessionStatus)
          : stopReason === 'cancelled'
            ? 'stopped'
            : 'done';
      state.status = status;
      if (status === 'failed' && typeof p.reason === 'string' && p.reason) state.failureReason = p.reason;
      state.currentStep = null;
      break;
    }
    default:
      // user_message_chunk / available_commands_update / session_info_update / usage_update /
      // current_mode_update / etc — not part of the v1 card, forwarded and
      // stored elsewhere, just not projected here.
      break;
  }
}

/** Folds a full run event log into a `SessionCard`, in seq order, from scratch. */
export function projectSessionCard(events: readonly SessionEvent[]): SessionCard {
  const card = newSessionCard();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) applySessionEvent(card, event);
  return card;
}

/**
 * The status to show for a run. The event log says "running" until it sees
 * `turn_ended`; a run the relay already marks finished (e.g. one interrupted
 * by an app quit and closed out later) must not keep spinning.
 */
export function effectiveRunStatus(metaStatus: SessionStatus, card: Pick<SessionCard, 'status'>): SessionStatus {
  const finished = metaStatus === 'done' || metaStatus === 'failed' || metaStatus === 'stopped';
  return card.status === 'running' && finished ? metaStatus : card.status;
}

