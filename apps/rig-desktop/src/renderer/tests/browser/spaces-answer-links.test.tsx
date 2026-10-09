import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import { OpenPageContext } from '@renderer/features/spaces/components/transcript-items';
import type { RoomMember, SessionEvent, SessionRunMeta } from '@renderer/features/spaces/types';
import '@renderer/tokens.css';

const openExternal = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal } } }));

/**
 * A link in an agent's answer opens beside the Room like the chat's own
 * links: Claude said "The Test artifact is a Claude Doc on claude.ai, open
 * beside the chat", and its link went to the laptop's browser. Only a link
 * that can't work there (a meeting, a download) or a ⌘-click goes to the
 * browser.
 */

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  openExternal.mockClear();
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
const meta: SessionRunMeta = {
  id: 'run-1',
  agent: 'claude',
  owner: 'alice',
  model: 'opus',
  title: '',
  status: 'done',
  startedAt: STARTED,
  endedAt: new Date(Date.parse(STARTED) + 4_000).toISOString(),
};
const ARTIFACT = 'https://claude.ai/artifact/6f0c2a7e-1b2c-4d5e-8f90-123456789abc';
const answer = (text: string): SessionEvent[] => [
  { seq: 1, kind: 'agent_message_chunk', payload: { messageId: 'm', content: { type: 'text', text } } },
  { seq: 2, kind: 'turn_ended', payload: { status: 'done' } },
];

async function show(text: string, openPage: (url: string, title: string) => void) {
  await act(async () => {
    root.render(
      <OpenPageContext.Provider value={openPage}>
        <SessionCard meta={meta} events={answer(text)} owner={alice} viewerIsOwner />
      </OpenPageContext.Provider>
    );
  });
  return host.querySelector<HTMLAnchorElement>('a[href^="http"]')!;
}

describe('a link in an agent answer', () => {
  it('opens a Claude artifact beside the Room', async () => {
    const openPage = vi.fn();
    const link = await show(`The [Test artifact](${ARTIFACT}) is a Claude Doc on claude.ai, open beside the chat.`, openPage);
    await act(async () => link.click());
    expect(openPage).toHaveBeenCalledWith(ARTIFACT, 'claude.ai/artifact');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens a bare web link beside the Room too', async () => {
    const openPage = vi.fn();
    const link = await show('See https://example.com/notes for the rest.', openPage);
    await act(async () => link.click());
    expect(openPage).toHaveBeenCalledWith('https://example.com/notes', 'example.com/notes');
  });

  it('sends a meeting, or a ⌘-click, to the browser', async () => {
    const openPage = vi.fn();
    const meeting = await show('Join [the call](https://zoom.us/j/123).', openPage);
    await act(async () => meeting.click());
    expect(openExternal).toHaveBeenCalledWith('https://zoom.us/j/123');

    const link = await show(`[Test](${ARTIFACT})`, openPage);
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
    expect(openExternal).toHaveBeenCalledWith(ARTIFACT);
    expect(openPage).not.toHaveBeenCalled();
  });
});
