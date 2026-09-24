import { createChatState, tailMode } from '@emdash/chat-ui';
import { useEffect, useMemo } from 'react';
import { ChatTranscript } from '@renderer/lib/chat/chat-transcript';
import { getSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { replaySessionTranscript } from '../session-transcript';
import type { SessionEvent } from '../types';

/**
 * A space run's full trace, rendered exactly like a rig chat session: the
 * run log is replayed through chat's transcript parser and shown with chat's
 * own `ChatTranscript` (tool calls, diffs, thinking, markdown). Read-only;
 * re-seeded as new events stream in while the run is live.
 */
export function SessionTrace({
  runId,
  events,
  running,
  className = 'h-[420px]',
}: {
  runId: string;
  events: SessionEvent[];
  running: boolean;
  /** Sizes the trace; it scrolls inside whatever box this gives it. */
  className?: string;
}) {
  const context = getSharedChatContext();
  const state = useMemo(() => createChatState(context, { uri: `space-run:${runId}` }), [context, runId]);

  useEffect(() => {
    const { committed, active } = replaySessionTranscript(runId, events);
    state.transcript.history.seed(committed);
    if (active) state.transcript.activeTurn.set(active, running ? 'generating' : 'done');
  }, [state, runId, events, running]);

  return (
    <div className={className} data-testid="session-trace">
      <ChatTranscript
        context={context}
        state={state}
        stickToBottom
        onReady={(view) => view.setScrollMode(tailMode())}
      />
    </div>
  );
}
