import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RoomTranscript,
  type TranscriptFocus,
} from '@renderer/features/spaces/components/room-transcript';
import type { RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';
import '@renderer/tokens.css';

// The session card renders answers with SafeMarkdown, which imports the IPC bridge.
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: { openExternal: async () => {} }, rig: {} },
  events: { on: () => () => {} },
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

function text(id: string, seq: number, extra: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id,
    seq,
    authorId: seq % 2 ? 'sam' : 'maya',
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, seq * 10)).toISOString(),
    time: '10:00',
    body: `body of ${id}`,
    meta: { kind: 'text' },
    ...extra,
  };
}

function roomOf(messages: RoomMessage[]): RoomSnapshot {
  return {
    name: 'launch',
    ready: true,
    members: [
      { id: 'me', name: 'Dylan', email: 'd@x.co', role: 'owner', initial: 'D', status: 'here' },
      { id: 'sam', name: 'Sam', email: 's@x.co', role: 'editor', initial: 'S', status: 'here' },
      { id: 'maya', name: 'Maya', email: 'm@x.co', role: 'editor', initial: 'M', status: 'here' },
    ],
    agents: [],
    connectors: [],
    skills: [],
    messages,
    invitesById: {},
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    typingUserIds: [],
  };
}

const six = () => Array.from({ length: 6 }, (_, i) => text(`m${i + 1}`, i + 1));

describe('Room transcript: focus', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'display:flex;flex-direction:column;height:600px;width:900px';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  });

  const foldLabel = (n: number) => `${n} messages in other themes`;
  const focusOn = (ids: string[], extra: Partial<TranscriptFocus> = {}): TranscriptFocus => ({
    messageIds: new Set(ids),
    foldLabel,
    ...extra,
  });
  const render = async (
    snapshot: RoomSnapshot,
    props: Partial<React.ComponentProps<typeof RoomTranscript>> = {}
  ) => {
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="me" {...props} />);
    });
  };
  /** The transcript's rows in order: message ids, and "fold" for a fold row. */
  const rows = () =>
    Array.from(
      host.querySelectorAll<HTMLElement>(
        '[data-message-id], [data-testid="transcript-fold"], [data-testid="transcript-fold-back"]'
      )
    ).map(
      (el) =>
        el.dataset.messageId ?? (el.dataset.testid === 'transcript-fold' ? 'fold' : 'fold-back')
    );

  it('without a focus renders every message and no fold row', async () => {
    await render(roomOf(six()));
    expect(rows()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    await render(roomOf(six()), { focus: undefined });
    expect(host.querySelector('[data-testid="transcript-fold"]')).toBeNull();
    expect(host.querySelector('[data-dimmed]')).toBeNull();
  });

  it('keeps the focused messages and folds each run of the others into one counted row', async () => {
    await render(roomOf(six()), { focus: focusOn(['m2', 'm3']) });
    expect(rows()).toEqual(['fold', 'm2', 'm3', 'fold']);
    const folds = [...host.querySelectorAll('[data-testid="transcript-fold"]')].map(
      (f) => f.textContent
    );
    expect(folds).toEqual(['1 messages in other themes', '3 messages in other themes']);
  });

  it('opens a fold in place, dimmed, and folds it back', async () => {
    await render(roomOf(six()), { focus: focusOn(['m2', 'm3']) });
    await act(async () => click(host.querySelectorAll('[data-testid="transcript-fold"]')[1]!));
    expect(rows()).toEqual(['fold', 'm2', 'm3', 'fold-back', 'm4', 'm5', 'm6']);
    const dimmed = [...host.querySelectorAll<HTMLElement>('[data-dimmed="true"]')].map(
      (el) => el.dataset.messageId
    );
    expect(dimmed).toEqual(['m4', 'm5', 'm6']);
    expect(host.querySelector('[data-testid="transcript-fold-back"]')?.textContent).toBe(
      'Hide 3 messages in other themes'
    );
    await act(async () => click(host.querySelector('[data-testid="transcript-fold-back"]')!));
    expect(rows()).toEqual(['fold', 'm2', 'm3', 'fold']);
  });

  it('closes opened folds when the focus changes', async () => {
    await render(roomOf(six()), { focus: focusOn(['m2'], { key: 'a' }) });
    await act(async () => click(host.querySelectorAll('[data-testid="transcript-fold"]')[0]!));
    expect(rows()).toEqual(['fold-back', 'm1', 'm2', 'fold']);
    await render(roomOf(six()), { focus: focusOn(['m2'], { key: 'b' }) });
    expect(rows()).toEqual(['fold', 'm2', 'fold']);
  });

  it('counts a comment thread as kept when any of its messages is, and shows it whole', async () => {
    const comment = (id: string, seq: number, isReply: boolean) =>
      text(id, seq, {
        threadId: 'c1',
        meta: {
          kind: 'comment_mirror',
          commentId: 'c1',
          path: 'a.md',
          quote: 'q',
          ...(isReply ? { isReply: true } : {}),
        },
      });
    const messages = [
      text('m1', 1),
      comment('c1', 2, false),
      text('m3', 3),
      comment('r1', 4, true),
      text('m5', 5),
    ];
    await render(roomOf(messages), { focus: focusOn(['r1']) });
    // The thread sits where it was last active (after m3); m1 and m3 fold around... m1 and m3 are other units.
    expect(rows()).toEqual(['fold', 'c1', 'fold']);
    expect(host.querySelector('[data-testid="comment-thread"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="transcript-fold"]')[0]!.textContent).toBe(
      '2 messages in other themes'
    );
  });

  it('counts in a fold what the transcript would draw: no agent mirror line a thread skips, no day divider', async () => {
    const mirror = (id: string, seq: number, extra: Record<string, unknown> = {}) =>
      text(id, seq, {
        threadId: 'c1',
        meta: {
          kind: 'comment_mirror',
          commentId: 'c1',
          path: 'a.md',
          quote: 'q',
          ...extra,
        } as RoomMessage['meta'],
      });
    const messages = [
      text('m1', 1),
      mirror('c-root', 2),
      // The agent's answer is mirrored here and also drawn as its run: only the run shows.
      mirror('c-mirror', 3, { isReply: true, replyFromAgent: 'claude' }),
      text('c-run', 4, { threadId: 'c1', meta: { kind: 'session', runId: 'r1' } }),
      text('divider', 5, { meta: { kind: 'system', event: 'day_divider' } }),
      text('m6', 6),
    ];
    await render(roomOf(messages), { focus: focusOn(['m1', 'm6']) });
    expect(rows()).toEqual(['m1', 'fold', 'm6']);
    // Four messages are folded; the thread draws two of its three, and the divider none.
    expect(host.querySelector('[data-testid="transcript-fold"]')!.textContent).toBe(
      '2 messages in other themes'
    );
    // A run of units that draw nothing has no row at all.
    await render(
      roomOf([
        text('m1', 1),
        text('divider', 2, { meta: { kind: 'system', event: 'day_divider' } }),
        text('m3', 3),
      ]),
      {
        focus: focusOn(['m1', 'm3']),
      }
    );
    expect(rows()).toEqual(['m1', 'm3']);
  });

  it('asks-first: asks, then the other kept units, each in order, then one fold for the rest', async () => {
    await render(roomOf(six()), {
      focus: focusOn(['m2', 'm3', 'm5', 'm6'], {
        order: 'asks-first',
        askIds: new Set(['m6', 'm5']),
        foldLabel: (n) => `${n} not waiting on you`,
      }),
    });
    expect(rows()).toEqual(['m5', 'm6', 'm2', 'm3', 'fold']);
    expect(host.querySelector('[data-testid="transcript-fold"]')?.textContent).toBe(
      '2 not waiting on you'
    );
    // Opened, the rest follows the fold row dimmed.
    await act(async () => click(host.querySelector('[data-testid="transcript-fold"]')!));
    expect(rows()).toEqual(['m5', 'm6', 'm2', 'm3', 'fold-back', 'm1', 'm4']);
  });

  it('has no fold row when everything is kept, and one row when nothing is', async () => {
    await render(roomOf(six()), { focus: focusOn(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) });
    expect(rows()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    await render(roomOf(six()), { focus: focusOn([]) });
    expect(rows()).toEqual(['fold']);
  });

  it('puts the day divider only around shown units', async () => {
    const day = (d: number, m: RoomMessage): RoomMessage => ({
      ...m,
      createdAt: new Date(Date.UTC(2026, 9, d, 10)).toISOString(),
    });
    const messages = [
      day(1, text('m1', 1)),
      day(2, text('m2', 2)),
      day(3, text('m3', 3)),
      day(3, text('m4', 4)),
    ];
    await render(roomOf(messages), { focus: focusOn(['m1', 'm4']) });
    const order = Array.from(
      host.querySelectorAll(
        '[data-message-id], [data-testid="transcript-fold"], [data-testid="day-divider"]'
      )
    ).map((el) => (el as HTMLElement).dataset.messageId ?? (el as HTMLElement).dataset.testid);
    // Two folded days between m1 and m4 never get a divider of their own; m4's day does.
    expect(order).toEqual(['day-divider', 'm1', 'transcript-fold', 'day-divider', 'm4']);
  });

  it('moves the "New" line to the next shown unit when the first new one is folded', async () => {
    localStorage.setItem('rig-room-last-seen:space-1', '2');
    // m3 is the first message after the read marker from someone else (m3 is Sam's).
    await render(roomOf(six()), { readKey: 'space-1', focus: focusOn(['m5']) });
    const order = Array.from(
      host.querySelectorAll(
        '[data-message-id], [data-testid="transcript-fold"], [data-testid="new-divider"]'
      )
    ).map((el) => (el as HTMLElement).dataset.messageId ?? (el as HTMLElement).dataset.testid);
    expect(order).toEqual(['transcript-fold', 'new-divider', 'm5', 'transcript-fold']);
  });

  it('opens the fold holding a message a jump asks for, then scrolls to it', async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push((this as HTMLElement).dataset.messageId ?? '');
    };
    try {
      const focus = focusOn(['m5']);
      await render(roomOf(six()), { focus });
      expect(host.querySelector('[data-message-id="m2"]')).toBeNull();
      await render(roomOf(six()), { focus, jump: { messageId: 'm2', nonce: 1 } });
      await vi.waitFor(() => expect(host.querySelector('[data-message-id="m2"]')).not.toBeNull());
      await vi.waitFor(() => expect(scrolled).toContain('m2'));
      // A kept message jumps straight away.
      await render(roomOf(six()), { focus, jump: { messageId: 'm5', nonce: 2 } });
      await vi.waitFor(() => expect(scrolled).toContain('m5'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('does not count what lands in the folded rest as new while scrolled up', async () => {
    const style = document.createElement('style');
    style.textContent = '[data-testid="room-transcript"] { height: 200px; overflow-y: auto; }';
    document.head.appendChild(style);
    try {
      const many = Array.from({ length: 30 }, (_, i) => text(`n${i + 1}`, i + 1));
      const focus = focusOn(
        many.map((m) => m.id),
        { key: 't' }
      );
      await render(roomOf(many), { focus });
      const scroller = host.querySelector<HTMLElement>('[data-testid="room-transcript"]')!;
      await act(async () => {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll'));
      });
      await vi.waitFor(() =>
        expect(host.querySelector('[data-testid="jump-to-latest"]')).not.toBeNull()
      );
      await render(roomOf([...many, text('other', 31)]), { focus });
      expect(host.querySelector('[data-testid="jump-to-latest"]')?.textContent).not.toContain(
        'new message'
      );
      const withFocused = text('theme-new', 32);
      await render(roomOf([...many, text('other', 31), withFocused]), {
        focus: focusOn([...many.map((m) => m.id), 'theme-new'], { key: 't' }),
      });
      expect(host.querySelector('[data-testid="jump-to-latest"]')?.textContent).toContain(
        '1 new message'
      );
    } finally {
      style.remove();
    }
  });
});
