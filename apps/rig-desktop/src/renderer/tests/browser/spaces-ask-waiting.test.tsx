import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A message that asked an agent shows "Waiting for Claude to start" under it
 * until a run starts on it, so a request nobody has claimed yet is visible.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    agents: { list: async () => [] },
    rig: { pages: { linkTitle: async () => null } },
  },
  events: { on: () => () => {} },
}));

import { MessageRow } from '@renderer/features/spaces/components/transcript-items';
import type { RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

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

const now = new Date().toISOString();
const ask = (authorId: string): RoomMessage =>
  ({
    id: 'ask',
    seq: 1,
    authorId,
    body: '@claude sum this up',
    createdAt: now,
    time: '10:00',
    meta: { kind: 'text', asks: 'claude' },
  }) as RoomMessage;
const run: RoomMessage = {
  id: 'run',
  seq: 2,
  authorId: 'u_me',
  body: 'sum this up',
  createdAt: now,
  time: '10:00',
  meta: { kind: 'session', runId: 'r1', sourceMessageId: 'ask' },
};

function snapshot(messages: RoomMessage[]): RoomSnapshot {
  return {
    members: [
      { id: 'u_me', name: 'Me' },
      { id: 'u_sam', name: 'Sam' },
    ],
    agents: [],
    messages,
  } as unknown as RoomSnapshot;
}

async function show(message: RoomMessage, messages: RoomMessage[]): Promise<string | null> {
  await act(async () => root.render(<MessageRow message={message} snapshot={snapshot(messages)} ownId="u_me" />));
  return host.querySelector('[data-testid="ask-waiting"]')?.textContent ?? null;
}

describe('a message waiting on an agent', () => {
  it('says your agent has not started yet', async () => {
    const mine = ask('u_me');
    expect(await show(mine, [mine])).toBe('Waiting for Claude to start');
  });

  it("names whose agent for someone else's ask", async () => {
    const theirs = ask('u_sam');
    expect(await show(theirs, [theirs])).toBe("Waiting for Sam's Claude to start");
  });

  it('goes once a run starts on it', async () => {
    const mine = ask('u_me');
    expect(await show(mine, [mine, run])).toBeNull();
  });
});
