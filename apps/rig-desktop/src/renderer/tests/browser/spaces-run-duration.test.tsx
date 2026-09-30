import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import type { RoomMember, SessionEvent, SessionRunMeta } from '@renderer/features/spaces/types';
import '@renderer/tokens.css';

// SafeMarkdown (the answer) imports the IPC bridge; nothing here opens a link.
vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal: async () => {} } } }));

/**
 * "Worked Xs" on a finished run is its end minus its start, never measured
 * against the clock: the header a Room holds for a run it saw start was read
 * while it ran (no end time), and a card remounted minutes later used to show
 * "Worked 3m 35s" for a 13-second run.
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
const THREE_MINUTES_AGO = new Date(Date.now() - 3 * 60_000).toISOString();
const EVENTS: SessionEvent[] = [
  { seq: 1, kind: 'tool_call', payload: { toolCallId: 'r1', kind: 'read', status: 'completed', title: 'Read notes.md' } },
  { seq: 2, kind: 'tool_call', payload: { toolCallId: 'r2', kind: 'read', status: 'completed', title: 'Read plan.md' } },
  { seq: 3, kind: 'agent_message_chunk', payload: { messageId: 'm', content: { type: 'text', text: 'Done.' } } },
  { seq: 4, kind: 'turn_ended', payload: { status: 'done' } },
];

function meta(overrides: Partial<SessionRunMeta>): SessionRunMeta {
  return {
    id: 'run-1',
    agent: 'claude',
    owner: 'alice',
    model: 'opus',
    title: '',
    status: 'running',
    startedAt: THREE_MINUTES_AGO,
    endedAt: null,
    ...overrides,
  };
}

const summary = () => host.querySelector('[data-testid="session-summary"]')?.textContent ?? '';

describe('a finished run’s duration', () => {
  it('is ended − started, however long ago it finished', async () => {
    const endedAt = new Date(Date.parse(THREE_MINUTES_AGO) + 13_000).toISOString();
    await act(async () => {
      root.render(<SessionCard meta={meta({ status: 'done', endedAt })} events={EVENTS} owner={alice} viewerIsOwner />);
    });
    expect(summary()).toMatch(/^Worked 13s · 2 steps/);
  });

  it('is never measured against now when the header was read while it ran (no end time yet)', async () => {
    // The Room's header for this run is the one it read at the start: still
    // "running", no end time. The log says it ended three minutes ago.
    await act(async () => {
      root.render(<SessionCard meta={meta({})} events={EVENTS} owner={alice} viewerIsOwner />);
    });
    expect(summary()).not.toMatch(/\dm/);
    expect(summary()).toMatch(/^Worked · 2 steps/);
  });
});
