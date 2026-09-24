import type { PromptAttachment, QueuedPrompt } from '@emdash/core/acp';
import type { AcpAgentApi } from '@emdash/core/agents/plugins';
import type { Logger } from '@emdash/shared/logger';

export interface ResolvedPromptAttachment {
  data: string;
  mimeType: string;
}

export type ResolvePromptAttachment = (
  attachment: PromptAttachment
) => Promise<ResolvedPromptAttachment>;

/**
 * In-band turn boundary markers for a conversation's raw session-event
 * stream (see `SessionManager.observeRawSessionEvents`/`RawSessionEvent`).
 * Emitted synchronously around the same `agent.prompt()` call whose
 * `session/update` notifications a raw observer also sees on that stream,
 * so a consumer never has to infer turn ownership from a separately
 * delivered busy/idle signal, which arrives on a different channel with no
 * ordering guarantee relative to the raw events themselves.
 *
 * `turnId` is the prompt's own id (the same id `queuePrompt`/`prompt`
 * generate) — stable across `turn_start` and its matching `turn_end`, so a
 * caller that queued a specific prompt can bind to exactly its own turn.
 * `turn_end.stopReason` mirrors the ACP `PromptResponse.stopReason` on a
 * normal completion, and is `null` when the turn ended via a thrown error
 * (mirroring `TranscriptTurnOutcome`'s own `'error'` case).
 */
export type TurnBoundaryEvent =
  | { kind: 'turn_start'; turnId: string }
  | { kind: 'turn_end'; turnId: string; stopReason: string | null };

export interface SessionCellCallbacks {
  onSessionStateChanged?: () => void;
  onTranscriptChanged?: () => void;
  onDraftChanged?: () => void;
  onClosed?: (exitCode: number | null) => void;
  onAgentEvent?: (phase: 'start' | 'stop' | 'error') => void;
  onSendQueuedPrompt?: (prompt: QueuedPrompt) => void;
  onTurnBoundary?: (event: TurnBoundaryEvent) => void;
}

export interface SessionCellDeps {
  conversationId: string;
  projectId: string;
  taskId: string;
  providerId: string;
  acpSessionId: string;
  agent: AcpAgentApi;
  resolveAttachment: ResolvePromptAttachment;
  logger: Logger;
  callbacks?: SessionCellCallbacks;
}

export interface SessionPromptResult {
  queued: boolean;
}
