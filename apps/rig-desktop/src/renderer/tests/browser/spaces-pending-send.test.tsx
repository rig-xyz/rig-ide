import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomTranscript } from '@renderer/features/spaces/components/room-transcript';
import { withPendingSends } from '@renderer/features/spaces/pending-sends';
import { emptySnapshot } from '@renderer/features/spaces/relay-room-source';
import type { RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';
import '@renderer/tokens.css';

// Message rows render with SafeMarkdown, which imports the IPC bridge (for opening links).
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: { openExternal: async () => {} } },
  events: { on: () => () => {} },
}));

function message(id: string, seq: number, authorId: string, body: string, extra: Partial<RoomMessage> = {}): RoomMessage {
  const createdAt = `2026-09-30T10:00:0${seq}Z`;
  return { id, seq, authorId, createdAt, time: '10:00', body, meta: { kind: 'text' }, ...extra };
}

describe('Room transcript — your message while it sends', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'display:flex;flex-direction:column;height:360px;width:900px';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("the grey bubble turns solid in place when the relay's copy comes in: same row, no second copy, no entrance", async () => {
    const base: RoomSnapshot = {
      ...emptySnapshot('Growth', 'bob'),
      loaded: true,
      members: [
        { id: 'bob', name: 'Bob' },
        { id: 'sam', name: 'Sam' },
      ] as RoomSnapshot['members'],
      messages: [message('m1', 1, 'sam', 'morning')],
    };
    const pending = [{ localId: 'local-1', text: 'on my way', createdAt: '2026-09-30T10:00:02Z', id: null }];
    await act(async () => {
      root.render(<RoomTranscript snapshot={withPendingSends(base, pending, 'bob')} ownId="bob" />);
    });
    const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-testid="message-row"]'));
    const grey = rows().at(-1)!;
    expect(grey.dataset.sending).toBe('true');
    const greyRow = grey.closest<HTMLElement>('[data-message-id]')!;

    // The relay's copy (it carries the client id) lands; the pending list hasn't been pruned yet.
    const arrived = { ...base, messages: [...base.messages, message('m2', 2, 'bob', 'on my way', { clientId: 'local-1' })] };
    await act(async () => {
      root.render(<RoomTranscript snapshot={withPendingSends(arrived, pending, 'bob')} ownId="bob" />);
    });
    const mine = rows().filter((r) => r.textContent?.includes('on my way'));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.dataset.sending).toBeUndefined();
    expect(mine[0]!.textContent).not.toContain('Sending…');
    const solidRow = mine[0]!.closest<HTMLElement>('[data-message-id]')!;
    expect(solidRow).toBe(greyRow); // the same row, kept — not a new one animating in
    expect(solidRow.dataset.messageId).toBe('m2');
    expect(solidRow.dataset.rowEntered).toBeUndefined();
    expect(rows().map((r) => r.closest<HTMLElement>('[data-message-id]')!.dataset.messageId)).toEqual(['m1', 'm2']);
  });
});
