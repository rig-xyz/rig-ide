import { err, ok } from '@emdash/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Search in a space's chat: Cmd-F opens a field over the chat, a query
 * filters the transcript in place to what matches (loaded messages at once,
 * older ones from the relay), × or Esc puts the chat back where it was.
 * Against a live Room on a fake relay (polling, no socket).
 */

const state = vi.hoisted(() => ({ view: 'flow' as 'flow' | 'threads' }));

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
import { RelayRoomSource } from '@renderer/features/spaces/relay-room-source';
import { roomSourceCache } from '@renderer/features/spaces/room-source-cache';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const ME = 'u1';
const BINDING = 'b-search';
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
function row(id: string, seq: number, author: string, body: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    seq,
    author: { userId: author, name: NAMES[author]!, avatarUrl: null, kind: 'user' },
    kind: 'text',
    body,
    meta: null,
    createdAt: new Date(Date.UTC(2026, 9, 5, 9, seq)).toISOString(),
    ...extra,
  };
}
const session = (id: string, seq: number, runId: string) =>
  row(id, seq, 'u2', 'Asked Claude', { kind: 'session', meta: { runId } });

/** Each run's answer, as the relay keeps it. */
const ANSWERS: Record<string, string> = {
  r1: 'The quarterly forecast is ready.',
  r2: 'Archived answer about the zeppelin budget.',
};

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function cmdF(target: EventTarget = document.body): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('Search in a space’s chat', () => {
  let host: HTMLDivElement;
  let root: Root;
  let stored: Row[];
  let searches: Array<{ q: string; before?: number }>;
  let relayDown: boolean;

  const input = () => host.querySelector<HTMLInputElement>('[data-testid="chat-search-input"]');
  const status = () => host.querySelector<HTMLElement>('[data-testid="chat-search-status"]')?.textContent ?? null;
  const results = () => host.querySelector<HTMLElement>('[data-testid="chat-search-results"]');
  const resultIds = () =>
    Array.from(results()?.querySelectorAll<HTMLElement>(':scope [data-message-id]') ?? [])
      .filter((el) => !el.parentElement?.closest('[data-message-id]'))
      .map((el) => el.dataset.messageId);
  const chat = () => host.querySelector<HTMLElement>('[data-testid="room-transcript"]')!;
  const chatHidden = () => chat().closest('.invisible') !== null;

  async function open(): Promise<RelayRoomSource> {
    const relay = {
      mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      listMembers: async () =>
        ok(Object.entries(NAMES).map(([userId, name]) => ({ userId, clerkUserId: null, name, email: null, role: 'owner', avatarUrl: null }))),
      listMessages: async (_b: string, query: { latest?: number; after?: string; before?: string }) => {
        if (query.after) return ok(stored.filter((m) => m.seq > Number(query.after)));
        if (query.before) return ok(stored.filter((m) => m.seq < Number(query.before)).slice(-(query.latest ?? 50)));
        return ok(stored.slice(-(query.latest ?? 50)));
      },
      getSessionEvents: async (_b: string, runId: string) =>
        ok({
          run: {
            id: runId,
            bindingId: BINDING,
            ownerUserId: 'u2',
            agent: 'claude',
            model: 'opus',
            status: 'done',
            title: null,
            commands: null,
            startedAt: '2026-10-05T09:00:00Z',
            endedAt: '2026-10-05T09:01:00Z',
          },
          events: [
            { seq: 1, kind: 'tool_call', payload: { toolCallId: 't1', title: 'Read notes', kind: 'read', status: 'completed' }, bytes: 10, truncated: false, originalBytes: null },
            { seq: 2, kind: 'agent_message_chunk', payload: { messageId: 'a', content: { type: 'text', text: ANSWERS[runId] ?? '' } }, bytes: 10, truncated: false, originalBytes: null },
            { seq: 3, kind: 'turn_ended', payload: { stopReason: 'end_turn' }, bytes: 10, truncated: false, originalBytes: null },
          ],
        }),
      // The relay's rules: every word as the start of a word, in a body or a run's answer; newest first.
      searchMessages: async (_b: string, query: { q: string; before?: number }) => {
        searches.push(query);
        if (relayDown) return err({ kind: 'network', message: 'offline' });
        const words = query.q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        const hit = (text: string) => words.every((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w}`, 'iu').test(text));
        const found = stored
          .filter((m) => query.before === undefined || m.seq < query.before)
          .filter((m) => (m.kind === 'session' ? hit(ANSWERS[String(m.meta?.runId)] ?? '') : m.kind === 'text' && hit(m.body)))
          .sort((a, b) => b.seq - a.seq);
        return ok({
          results: found.map((m) => ({
            messageId: m.id,
            seq: m.seq,
            kind: m.kind === 'session' ? 'answer' : 'message',
            runId: m.kind === 'session' ? String(m.meta?.runId) : null,
            createdAt: m.createdAt,
            snippet: { text: m.body, highlights: [] },
            message: m,
          })),
          nextBefore: null,
        });
      },
      postMessage: async () => ok({} as never),
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
        bootstrapMessageCount: 30,
        createProvider: () => quietProvider,
      })
    );
    await vi.waitFor(() => expect(lease.source.getSnapshot().loaded).toBe(true));
    const source = lease.source as RelayRoomSource;
    lease.release();
    await act(async () => root.render(<RoomView bindingId={BINDING} spaceName="#launch" />));
    await vi.waitFor(() => expect(chat().querySelector('[data-message-id="m200"]')).not.toBeNull());
    return source;
  }

  // The test page loads no Tailwind: give the transcripts the height and
  // scrolling, and the search results the place over the chat, that their
  // classes give them in the app.
  let style: HTMLStyleElement;
  beforeAll(() => {
    style = document.createElement('style');
    style.textContent = `
      [data-testid="room-transcript"] { height: 600px; overflow-y: auto; }
      .relative { position: relative; }
      .absolute { position: absolute; }
      .inset-0 { inset: 0; }
      .invisible { visibility: hidden; }
    `;
    document.head.appendChild(style);
  });
  afterAll(() => style.remove());

  beforeEach(() => {
    state.view = 'flow';
    localStorage.clear();
    searches = [];
    relayDown = false;
    stored = [];
    for (let seq = 1; seq <= 200; seq += 1) stored.push(row(`m${seq}`, seq, seq % 2 ? 'u2' : 'u3', `filler message ${seq}`));
    // Far older than the thirty the Room opens with: only the relay knows them.
    stored[1] = row('m2', 2, 'u3', 'The zeppelin launch is postponed');
    stored[4] = session('m5', 5, 'r2');
    // Loaded.
    stored[189] = row('m190', 190, 'u2', 'Pricing for the zeppelin tier');
    stored[191] = session('m192', 192, 'r1');
    stored[193] = row('m194', 194, 'u3', 'pricing page draft is up');
    host = document.createElement('div');
    host.style.width = '1200px';
    host.style.height = '800px';
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    roomSourceCache.clear();
  });

  it('Cmd-F opens a focused field, and again selects what is typed', async () => {
    await open();
    expect(input()).toBeNull();
    const event = await cmdF();
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
    await type(input()!, 'pricing');
    input()!.setSelectionRange(7, 7);
    await cmdF(input()!);
    expect(document.activeElement).toBe(input());
    expect([input()!.selectionStart, input()!.selectionEnd]).toEqual([0, 7]);
  });

  it('filters the chat in place to what matches, highlighted, and Esc puts it back where it was', async () => {
    await open();
    const scroller = chat();
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 400;
    scroller.dispatchEvent(new Event('scroll'));
    const before = scroller.scrollTop;
    expect(before).toBeGreaterThan(300);

    await cmdF();
    await type(input()!, 'pricing');
    await vi.waitFor(() => expect(resultIds()).toEqual(['m190', 'm194']));
    expect(status()).toBe('2 matches for “pricing”');
    expect(chatHidden()).toBe(true);
    // The matches are painted with the search highlight.
    await vi.waitFor(() => expect(CSS.highlights.get('rig-chat-search')?.size).toBe(2));

    await act(async () => {
      input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(input()).toBeNull();
    expect(results()).toBeNull();
    expect(chatHidden()).toBe(false);
    expect(chat().scrollTop).toBe(before);
    expect(CSS.highlights.has('rig-chat-search')).toBe(false);
  });

  it('finds an older match only the relay has, and an agent’s answer far back, shown as its card', async () => {
    await open();
    await cmdF();
    await type(input()!, 'zeppelin');
    await vi.waitFor(() => expect(resultIds()).toEqual(['m2', 'm5', 'm190']));
    expect(searches.at(-1)).toEqual({ q: 'zeppelin', limit: 30 });
    // Never paged back to: the Room hasn't loaded it.
    expect(chat().querySelector('[data-message-id="m2"]')).toBeNull();
    expect(results()!.textContent).toContain('The zeppelin launch is postponed');
    // The far-back run's log loads, and its card shows the answer that matched.
    await vi.waitFor(() => expect(results()!.textContent).toContain('Archived answer about the zeppelin budget.'));
    expect(status()).toBe('3 matches for “zeppelin”');
  });

  it('finds an agent turn by its answer, not by what it was asked', async () => {
    await open();
    await vi.waitFor(() => expect(chat().textContent).toContain('The quarterly forecast is ready.'));
    await cmdF();
    await type(input()!, 'forecast');
    await vi.waitFor(() => expect(resultIds()).toEqual(['m192']));
    await type(input()!, 'asked claude');
    await vi.waitFor(() => expect(status()).toBe('No matches for “asked claude”'));
    expect(resultIds()).toEqual([]);
  });

  it('Show in chat closes the search and goes to the message, paging back to it', async () => {
    const source = await open();
    await cmdF();
    await type(input()!, 'postponed');
    await vi.waitFor(() => expect(resultIds()).toEqual(['m2']));
    await act(async () => results()!.querySelector<HTMLButtonElement>('[data-testid="search-show-in-chat"]')!.click());
    expect(input()).toBeNull();
    await vi.waitFor(() => expect(chat().querySelector('[data-message-id="m2"]')).not.toBeNull());
    expect(source.getSnapshot().messages.some((m) => m.id === 'm2')).toBe(true);
  });

  it('without the relay, says so and still shows what is loaded', async () => {
    relayDown = true;
    await open();
    await cmdF();
    await type(input()!, 'zeppelin');
    await vi.waitFor(() => expect(host.querySelector('[data-testid="chat-search-offline"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="chat-search-offline"]')!.textContent).toBe(
      'Search needs a connection for older messages'
    );
    expect(resultIds()).toEqual(['m190']);
  });

  it('in Threads view shows a matching reply flat, saying it is in a thread', async () => {
    state.view = 'threads';
    stored[195] = row('m196', 196, 'u2', 'Pricing reply', {
      meta: { replyTo: { id: 'm194', authorId: 'u3', label: 'Kim', excerpt: '…' } },
    });
    await open();
    await cmdF();
    await type(input()!, 'pricing');
    await vi.waitFor(() => expect(resultIds()).toEqual(['m190', 'm194', 'm196']));
    const labels = Array.from(results()!.querySelectorAll('[data-testid="search-context-label"]')).map((el) => el.textContent);
    expect(labels).toEqual(['In a thread']);
  });

  it('leaves Cmd-F alone outside the space’s chat, and when something else already took it', async () => {
    await open();
    const outside = document.createElement('div');
    outside.className = 'cm-editor';
    outside.tabIndex = 0;
    document.body.appendChild(outside);
    try {
      const event = await cmdF(outside);
      expect(event.defaultPrevented).toBe(false);
      expect(input()).toBeNull();
    } finally {
      outside.remove();
    }
    const taken = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
    taken.preventDefault();
    await act(async () => {
      document.body.dispatchEvent(taken);
    });
    expect(input()).toBeNull();
  });
});
