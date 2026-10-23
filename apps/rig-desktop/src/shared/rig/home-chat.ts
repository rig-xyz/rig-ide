import { defineEvent } from '@shared/lib/ipc/events';

/**
 * Home's chat with the person's own Claude, as runs the Room's cards can draw:
 * each message the person sends is one run, with the session's raw updates
 * (`{seq, kind: sessionUpdate, payload}`, the same events a space records) and
 * how it ended.
 */
export type HomeChatRun = {
  id: string;
  /** What the person asked. */
  prompt: string;
  at: string;
  status: 'running' | 'done' | 'stopped' | 'failed';
  endedAt: string | null;
  model: string;
  events: { seq: number; kind: string; payload: Record<string, unknown> }[];
};

/** A run changed (a new update, or it ended): the whole run, as it is now. */
export const homeChatRunChannel = defineEvent<{ run: HomeChatRun }>('rig:home-chat-run');
