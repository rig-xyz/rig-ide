import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import type { RoomMember, SessionEvent, SessionRunMeta } from '@renderer/features/spaces/types';
import '@renderer/tokens.css';

// SafeMarkdown (the answer) imports the IPC bridge; nothing here opens a link.
vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal: async () => {} } } }));

/**
 * A space turn may end with only a reaction: "thanks @claude" gets a 👍 and
 * no words. Its card says "Claude reacted 👍" instead of a blank answer.
 */

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const alice: RoomMember = { id: 'alice', name: 'Alice', email: 'alice@example.com', role: 'owner', initial: 'A', status: 'here' };
const STARTED = new Date(Date.now() - 60_000).toISOString();
const REACT_STEP: SessionEvent = {
  seq: 1,
  kind: 'tool_call',
  payload: { toolCallId: 't1', kind: 'other', status: 'completed', title: 'mcp__rig__rig_chat_react' },
};

function meta(agent: SessionRunMeta['agent'] = 'claude'): SessionRunMeta {
  return {
    id: 'run-1',
    agent,
    owner: 'alice',
    model: 'opus',
    title: '',
    status: 'done',
    startedAt: STARTED,
    endedAt: new Date(Date.parse(STARTED) + 4_000).toISOString(),
  };
}

const reacted = () => host.querySelector('[data-testid="session-reacted"]');

describe('a run that only reacted', () => {
  it('says "<Agent> reacted" with its emojis instead of a blank answer', async () => {
    const events = [REACT_STEP, { seq: 2, kind: 'turn_ended', payload: { status: 'done', reacted: ['👍', '🎉'] } }];
    await act(async () => {
      root.render(<SessionCard meta={meta()} events={events} owner={alice} viewerIsOwner />);
    });
    expect(reacted()?.textContent).toBe('Claude reacted 👍 🎉');
    expect(host.querySelector('[data-testid="session-failed-line"]')).toBeNull();
  });

  it('names Codex for a Codex run, for other members too', async () => {
    const events = [REACT_STEP, { seq: 2, kind: 'turn_ended', payload: { status: 'done', reacted: ['✅'] } }];
    await act(async () => {
      root.render(<SessionCard meta={meta('codex')} events={events} owner={alice} viewerIsOwner={false} />);
    });
    expect(reacted()?.textContent).toBe('Codex reacted ✅');
  });

  it('shows the answer, not the line, when the run also answered in words', async () => {
    const events = [
      REACT_STEP,
      { seq: 2, kind: 'agent_message_chunk', payload: { messageId: 'm', content: { type: 'text', text: 'Merged.' } } },
      { seq: 3, kind: 'turn_ended', payload: { status: 'done' } },
    ];
    await act(async () => {
      root.render(<SessionCard meta={meta()} events={events} owner={alice} viewerIsOwner />);
    });
    expect(reacted()).toBeNull();
    expect(host.textContent).toContain('Merged.');
  });
});
