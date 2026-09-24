import type { SessionUpdate } from '@agentclientprotocol/sdk';
// The browser-safe entry: '@emdash/core/acp' also pulls in Node-only transport code.
import { AcpTranscriptParser, type TranscriptTurn } from '@emdash/core/acp/transcript-parser';
import type { SessionEvent } from './types';

/**
 * Replays a space run's stored event log through the same ACP transcript
 * parser the rig chat uses, so the session card's expanded view can render
 * the run with chat's own `ChatTranscript` (tool calls, diffs, thinking,
 * markdown) instead of a second, poorer renderer.
 *
 * The log stores raw ACP `session/update` payloads (kind = their
 * `sessionUpdate`), plus a few spaces-only kinds (`turn_ended`,
 * `permission_*`) the parser doesn't know. The relay may coalesce adjacent
 * chunk events into `{ chunks: [...] }`; those are unwrapped in order.
 */
export function replaySessionTranscript(
  runId: string,
  events: readonly SessionEvent[]
): { committed: readonly TranscriptTurn[]; active: TranscriptTurn | null } {
  const parser = new AcpTranscriptParser({ conversationId: runId });
  const push = (payload: Record<string, unknown>, at: number | undefined) => {
    if (typeof payload.sessionUpdate !== 'string') return;
    parser.push(payload as unknown as SessionUpdate, at);
  };

  for (const event of events) {
    const at = typeof event.payload?.pubTs === 'number' ? event.payload.pubTs : undefined;
    if (event.kind === 'turn_ended') {
      parser.endTurn(at);
      continue;
    }
    const chunks = event.payload?.chunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        if (chunk && typeof chunk === 'object') push(chunk as Record<string, unknown>, at);
      }
    } else if (event.payload) {
      push(event.payload, at);
    }
  }
  return { committed: parser.history, active: parser.activeTurn };
}
