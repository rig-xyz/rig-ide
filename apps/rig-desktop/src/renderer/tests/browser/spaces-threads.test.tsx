import { ok } from '@emdash/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Threads view (Settings › Spaces › Chat view): the main column shows the
 * roots, each with a reply row; the row opens the thread in a panel with its
 * own composer. Against a live Room on a fake relay (polling, no socket).
 */

const state = vi.hoisted(() => ({ view: 'threads' as 'flow' | 'threads' }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    rig: {
      settings: { get: async () => ({ spacesChatView: state.view }), set: async () => ({}) },
      notifications: { setViewing: async () => undefined, markSpaceRead: async () => ({ success: true, data: undefined }) },
      spacesConnection: {
        getConnectionInfo: async () => ({ success: false, error: { message: 'offline' } }),
        log: async () => undefined,
      },
      spacesDispatch: { checkNow: async () => undefined, settleStaleRun: async () => ({ settled: true }) },
      attachments: { prepare: async () => ({ space: { status: 'ok' }, files: [] }) },
      recent: { resolveLocalPaths: async () => ({}) },
    },
  },
  events: { on: () => () => {} },
}));

vi.mock('@renderer/features/spaces/connectors-api', () => ({
  connectorsApi: {
    list: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue({ ok: true }),
    cancel: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    globalSetup: vi.fn().mockResolvedValue([]),
    projectServers: vi.fn().mockResolvedValue([]),
    allowProjectServer: vi.fn().mockResolvedValue(true),
  },
}));

import { RoomView } from '@renderer/features/spaces/components/room-view';
import type { RoomJumpRequest } from '@renderer/features/spaces/components/room-transcript';
import { RelayRoomSource } from '@renderer/features/spaces/relay-room-source';
import { roomSourceCache } from '@renderer/features/spaces/room-source-cache';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const ME = 'u1';
const BINDING = 'b-threads';
type Row = {
  id: string;
  seq: number;
  author: { userId: string; name: string; avatarUrl: null; kind: 'user' };
  kind: string;
  body: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
};
const NAMES: Record<string, string> = { u1: 'Me', u2: 'Sam', u3: 'Kim' };
function row(id: string, seq: number, author: string, body: string, meta: Record<string, unknown> | null = null): Row {
  return {
    id,
    seq,
    author: { userId: author, name: NAMES[author]!, avatarUrl: null, kind: 'user' },
    kind: 'text',
    body,
    meta,
    createdAt: `2026-10-05T09:0${seq}:00Z`,
  };
}
const replyTo = (id: string, authorId: string, label: string) => ({ replyTo: { id, authorId, label, excerpt: '…' } });

async function type(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter(textarea: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

describe('Threads view', () => {
  let host: HTMLDivElement;
  let root: Root;
  let stored: Row[];
  let posted: Array<{ body: string; meta: Record<string, unknown> | null }>;

  const panel = () => host.querySelector<HTMLElement>('[data-testid="thread-panel"]');
  const transcript = () => host.querySelector<HTMLElement>('[data-testid="room-transcript"]')!;
  const mainBodies = () =>
    Array.from(transcript().querySelectorAll<HTMLElement>('[data-testid="message-row"] [data-highlight-target]')).map(
      (el) => el.textContent
    );
  const replyRow = () => host.querySelector<HTMLButtonElement>('[data-testid="thread-reply-row"]');

  async function open(props: { split?: boolean; jump?: RoomJumpRequest } = {}): Promise<void> {
    const relay = {
      mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      listMembers: async () =>
        ok(
          Object.entries(NAMES).map(([userId, name]) => ({ userId, clerkUserId: null, name, email: null, role: 'owner', avatarUrl: null }))
        ),
      listMessages: async (_b: string, query: { latest?: number; after?: string; before?: string }) => {
        if (query.after) return ok(stored.filter((m) => m.seq > Number(query.after)));
        if (query.before) return ok(stored.filter((m) => m.seq < Number(query.before)).slice(-(query.latest ?? 50)));
        return ok(stored.slice(-(query.latest ?? 50)));
      },
      getSessionEvents: async () => ok({ run: null as never, events: [] }),
      postMessage: async (_b: string, input: { body: string; meta?: Record<string, unknown> }) => {
        posted.push({ body: input.body, meta: input.meta ?? null });
        const created = row(`p${stored.length + 1}`, stored.length + 1, ME, input.body, input.meta ?? null);
        stored.push(created);
        return ok(created);
      },
      requestOwnAgent: async () => ok({} as never),
    };
    const quietProvider = { connect: () => {}, disconnect: () => {}, destroy: () => {}, sendStateless: () => {}, on: () => {}, off: () => {}, awareness: null };
    roomSourceCache.rememberConnection({ selfUserId: ME, wsUrl: 'wss://relay.test/v1/realtime' });
    const lease = roomSourceCache.acquire(ME, BINDING, () =>
      new RelayRoomSource({
        bindingId: BINDING,
        spaceName: '#launch',
        wsUrl: 'wss://relay.test/v1/realtime',
        selfUserId: ME,
        relay: relay as never,
        connectGraceMs: 10,
        pollIntervalMs: 30,
        createProvider: () => quietProvider,
      })
    );
    await vi.waitFor(() => expect(lease.source.getSnapshot().loaded).toBe(true));
    lease.release();
    await act(async () =>
      root.render(<RoomView bindingId={BINDING} spaceName="#launch" split={props.split} jump={props.jump ?? null} />)
    );
  }

  beforeEach(() => {
    state.view = 'threads';
    localStorage.clear();
    posted = [];
    stored = [
      row('m1', 1, 'u2', 'Which launch date?'),
      row('m2', 2, 'u3', 'Tuesday', replyTo('m1', 'u2', 'Sam')),
      row('m3', 3, ME, 'Tuesday works', replyTo('m2', 'u3', 'Kim')),
      row('m4', 4, 'u3', 'Lunch?'),
      row('m5', 5, 'u2', 'Locked: Tuesday', { ...replyTo('m1', 'u2', 'Sam'), alsoInChannel: true }),
    ];
    host = document.createElement('div');
    host.style.width = '1400px';
    host.style.height = '800px';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    roomSourceCache.clear();
  });

  it('shows only roots, and replies also sent to the main column, with a reply row under the root', async () => {
    await open();
    await vi.waitFor(() => expect(replyRow()).not.toBeNull());
    expect(mainBodies()).toEqual(['Which launch date?', 'Lunch?', 'Locked: Tuesday']);
    // A reply to a reply is in the same thread: three replies, none nested.
    expect(replyRow()!.textContent).toContain('3 replies');
    expect(replyRow()!.textContent).toContain('last');
    expect(host.querySelectorAll('[data-testid="thread-reply-row"]')).toHaveLength(1);
  });

  it('Flow keeps one timeline, every reply in place with its quote line', async () => {
    state.view = 'flow';
    await open();
    await vi.waitFor(() =>
      expect(mainBodies()).toEqual(['Which launch date?', 'Tuesday', 'Tuesday works', 'Lunch?', 'Locked: Tuesday'])
    );
    expect(replyRow()).toBeNull();
    expect(host.querySelectorAll('[data-testid="reply-quote"]').length).toBeGreaterThan(0);
  });

  it('the reply row opens the thread beside the chat; × and Esc close it', async () => {
    await open();
    await vi.waitFor(() => expect(replyRow()).not.toBeNull());
    await act(async () => replyRow()!.click());
    expect(panel()?.dataset.mode).toBe('beside');
    const bodies = Array.from(panel()!.querySelectorAll('[data-highlight-target]')).map((el) => el.textContent);
    expect(bodies).toEqual(['Which launch date?', 'Tuesday', 'Tuesday works', 'Locked: Tuesday']);
    expect(panel()!.querySelector('[data-testid="thread-divider"]')!.textContent).toBe('3 replies');
    expect(panel()!.querySelector('textarea')!.getAttribute('placeholder')).toBe('Reply in thread');
    expect(panel()!.querySelector('[data-testid="thread-also-send"]')!.textContent).toBe('Also send to #launch');
    expect(replyRow()!.dataset.open).toBe('true');

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="thread-close"]')!.click());
    expect(panel()).toBeNull();

    await act(async () => replyRow()!.click());
    expect(panel()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  it('replying in the thread replies to its root; "Also send" marks it for the main column', async () => {
    await open();
    await vi.waitFor(() => expect(replyRow()).not.toBeNull());
    await act(async () => replyRow()!.click());
    const textarea = panel()!.querySelector('textarea')!;
    await type(textarea, 'Works for me');
    await pressEnter(textarea);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.meta).toMatchObject({ replyTo: { id: 'm1', authorId: 'u2', label: 'Sam' } });
    expect(posted[0]!.meta).not.toHaveProperty('alsoInChannel');
    // It shows in the thread, not in the main column.
    await vi.waitFor(() => expect(panel()!.textContent).toContain('Works for me'));
    expect(mainBodies()).not.toContain('Works for me');

    const box = panel()!.querySelector<HTMLInputElement>('[data-testid="thread-also-send"] input')!;
    await act(async () => box.click());
    expect(box.checked).toBe(true);
    await type(panel()!.querySelector('textarea')!, 'Shipping Tuesday');
    await pressEnter(panel()!.querySelector('textarea')!);
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.meta).toMatchObject({ replyTo: { id: 'm1' }, alsoInChannel: true });
    await vi.waitFor(() => expect(mainBodies()).toContain('Shipping Tuesday'));
    // Unticked again for the next reply.
    expect(panel()!.querySelector<HTMLInputElement>('[data-testid="thread-also-send"] input')!.checked).toBe(false);
  });

  it('Reply on a message in the main column opens its thread', async () => {
    await open();
    await vi.waitFor(() => expect(mainBodies()).toContain('Lunch?'));
    const lunch = Array.from(transcript().querySelectorAll<HTMLElement>('[data-testid="message-row"]')).find((r) =>
      r.textContent?.includes('Lunch?')
    )!;
    await act(async () => lunch.querySelector<HTMLButtonElement>('button[aria-label="Reply"]')!.click());
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain('Lunch?');
    // No replies yet: no divider.
    expect(panel()!.querySelector('[data-testid="thread-divider"]')).toBeNull();
    await type(panel()!.querySelector('textarea')!, 'Sure');
    await pressEnter(panel()!.querySelector('textarea')!);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.meta).toMatchObject({ replyTo: { id: 'm4', label: 'Kim' } });
  });

  it('in split view the thread replaces the chat column, and "‹ #space" goes back', async () => {
    await open({ split: true });
    await vi.waitFor(() => expect(replyRow()).not.toBeNull());
    await act(async () => replyRow()!.click());
    expect(panel()?.dataset.mode).toBe('replace');
    expect(transcript().closest('.hidden')).not.toBeNull();
    const back = host.querySelector<HTMLButtonElement>('[data-testid="thread-back"]')!;
    expect(back.textContent).toBe('#launch');
    expect(host.querySelector('[data-testid="thread-close"]')).toBeNull();
    await act(async () => back.click());
    expect(panel()).toBeNull();
    expect(transcript().closest('.hidden')).toBeNull();
  });

  it("lights the reply count while there are replies you haven't seen, until you open the thread", async () => {
    await open();
    await vi.waitFor(() => expect(replyRow()).not.toBeNull());
    expect(replyRow()!.dataset.unread).toBe('true');
    await act(async () => replyRow()!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="thread-close"]')!.click());
    await vi.waitFor(() => expect(replyRow()!.dataset.unread).toBeUndefined());
    // A new reply from someone else lights it again.
    stored.push(row('m6', 6, 'u3', 'Or Wednesday?', replyTo('m1', 'u2', 'Sam')));
    await vi.waitFor(() => expect(replyRow()!.textContent).toContain('4 replies'));
    expect(replyRow()!.dataset.unread).toBe('true');
  });

  it('a notification pointing at a reply opens its thread', async () => {
    await open({ jump: { messageId: 'm3', messageSeq: 3, nonce: 1 } });
    await vi.waitFor(() => expect(panel()).not.toBeNull());
    expect(panel()!.textContent).toContain('Tuesday works');
  });
});
