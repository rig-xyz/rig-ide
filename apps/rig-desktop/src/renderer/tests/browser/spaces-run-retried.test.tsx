import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retriedLater } from '@renderer/features/spaces/components/room-transcript';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import type { RoomMember, RoomMessage, RoomSnapshot, SessionEvent, SessionRunMeta } from '@renderer/features/spaces/types';
import '@renderer/tokens.css';

// SafeMarkdown (the answer) imports the IPC bridge; nothing here opens a link.
vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal: async () => {} } } }));

/**
 * A first try that failed on the agent's sign-in, then a try that worked:
 * the card shows the answer, and the failure only as a quiet line in its
 * details. Tried again in the same run (`run_retried`), or as a later run
 * of the same ask (Retry), whose card sits right under the failed one.
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

const hugo: RoomMember = { id: 'hugo', name: 'Hugo', email: 'hugo@example.com', role: 'member', initial: 'H', status: 'here' };
const T0 = Date.now() - 120_000;

function meta(id: string, status: SessionRunMeta['status'], startedMs: number): SessionRunMeta {
  return {
    id,
    agent: 'claude',
    owner: 'hugo',
    model: 'opus',
    title: '',
    status,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(startedMs + 7_000).toISOString(),
  };
}

const say = (seq: number, text: string): SessionEvent => ({
  seq,
  kind: 'agent_message_chunk',
  payload: { content: { type: 'text', text } },
});
const STEP: SessionEvent = {
  seq: 1,
  kind: 'tool_call',
  payload: { toolCallId: 't1', kind: 'read', status: 'completed', title: 'Read notes.md' },
};
const SIGN_IN_FAILED: SessionEvent[] = [
  say(1, 'API Error: 401 authentication_error'),
  { seq: 2, kind: 'turn_ended', payload: { status: 'failed', reason: "Hugo's Claude needs to sign in again." } },
];

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

async function expand() {
  await act(async () => (q('session-summary') as HTMLButtonElement).click());
}

describe('a run whose first try failed on its sign-in', () => {
  it('tried again in the same run: the answer, no error, and a quiet line in its details', async () => {
    const events: SessionEvent[] = [
      say(1, 'API Error: 401 authentication_error'),
      { seq: 2, kind: 'run_retried', payload: { reason: 'sign_in' } },
      { ...STEP, seq: 3 },
      say(4, 'The launch is on Friday.'),
      { seq: 5, kind: 'turn_ended', payload: { status: 'done' } },
    ];
    await act(async () => {
      root.render(<SessionCard meta={meta('run-1', 'done', T0)} events={events} owner={hugo} viewerIsOwner={false} />);
    });
    expect(q('session-failed-line')).toBeNull();
    expect(host.textContent).toContain('The launch is on Friday.');
    expect(host.textContent).not.toContain('401');
    expect(q('session-retried')).toBeNull();
    await expand();
    expect(q('session-retried')?.textContent).toBe('Signed in again and retried');
  });

  it('a failed run that a later Retry got past: no red error and no printed output, a quiet line instead', async () => {
    await act(async () => {
      root.render(
        <SessionCard meta={meta('run-1', 'failed', T0)} events={SIGN_IN_FAILED} owner={hugo} viewerIsOwner={false} retriedLater />
      );
    });
    expect(q('session-failed-line')).toBeNull();
    expect(host.textContent).not.toContain('What the agent printed');
    await expand();
    expect(q('session-retried')?.textContent).toBe('Signed in again and retried');
  });

  it('without a later run that worked, the failure stays', async () => {
    await act(async () => {
      root.render(<SessionCard meta={meta('run-1', 'failed', T0)} events={SIGN_IN_FAILED} owner={hugo} viewerIsOwner={false} />);
    });
    expect(q('session-failed-line')?.textContent).toContain("Hugo's Claude needs to sign in again.");
  });
});

describe('retriedLater', () => {
  const message = (id: string, runId: string, body: string): RoomMessage => ({
    id,
    seq: 0,
    authorId: 'hugo',
    createdAt: new Date(T0).toISOString(),
    time: '',
    body,
    meta: { kind: 'session', runId },
  });
  const DONE: SessionEvent[] = [say(1, 'Friday.'), { seq: 2, kind: 'turn_ended', payload: { status: 'done' } }];

  function snapshot(later: SessionRunMeta, laterEvents: SessionEvent[], laterBody = 'when is the launch?'): RoomSnapshot {
    return {
      messages: [message('m1', 'run-1', 'when is the launch?'), message('m2', later.id, laterBody)],
      sessionMetaByRun: { 'run-1': meta('run-1', 'failed', T0), [later.id]: later },
      sessionEventsByRun: { 'run-1': SIGN_IN_FAILED, [later.id]: laterEvents },
    } as unknown as RoomSnapshot;
  }

  it('is true for a failed run when the same ask to the same agent finished later', () => {
    const snap = snapshot(meta('run-2', 'done', T0 + 30_000), DONE);
    expect(retriedLater(snap.messages[0]!, snap)).toBe(true);
    expect(retriedLater(snap.messages[1]!, snap)).toBe(false);
  });

  it('is false when the later run failed too, asked something else, or is another agent', () => {
    const failed = snapshot(meta('run-2', 'failed', T0 + 30_000), SIGN_IN_FAILED);
    expect(retriedLater(failed.messages[0]!, failed)).toBe(false);
    const other = snapshot(meta('run-2', 'done', T0 + 30_000), DONE, 'something else');
    expect(retriedLater(other.messages[0]!, other)).toBe(false);
    const codex = snapshot({ ...meta('run-2', 'done', T0 + 30_000), agent: 'codex' }, DONE);
    expect(retriedLater(codex.messages[0]!, codex)).toBe(false);
  });
});
