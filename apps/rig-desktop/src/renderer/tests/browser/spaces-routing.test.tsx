import { ok } from '@emdash/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Smarter routing, the app's half: the send button says what will happen
 * (the relay's draft preview may say the draft is for your agent), its menu
 * flips that for the draft, and the router's private "Ask Claude?" under a
 * message you sent asks your agent in one click.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    // Both of your agents can run on this computer.
    agents: { list: async () => [{ id: 'claude', status: 'available' }, { id: 'codex', status: 'available' }] },
    rig: {
      settings: { get: async () => ({ spacesChatView: 'flow' }), set: async () => ({}) },
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

import type { DraftPreview } from '@main/rig/spaces-connection';
import { Composer, type ComposerPreview, type ComposerSendContext } from '@renderer/features/spaces/components/composer';
import { RoomView } from '@renderer/features/spaces/components/room-view';
import { RelayRoomSource } from '@renderer/features/spaces/relay-room-source';
import { roomSourceCache } from '@renderer/features/spaces/room-source-cache';
import type { ComposerRoute } from '@renderer/features/spaces/send-decision';
import type { RoomAgent } from '@renderer/features/spaces/types';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

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

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const ASK: ComposerRoute = { action: 'ask', agent: 'claude' };
const NONE: ComposerRoute = { action: 'none', agent: null };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Room composer — the send button says what will happen', () => {
  let host: HTMLDivElement;
  let root: Root;
  let sent: Array<[string, ComposerSendContext]>;

  const own: RoomAgent[] = [
    { agent: 'claude', owner: 'me', model: '', busy: false },
    { agent: 'codex', owner: 'me', model: '', busy: false },
  ];
  const label = () => host.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.textContent;
  const toggle = () => host.querySelector<HTMLButtonElement>('[data-testid="composer-send-menu-toggle"]');
  const option = (key: string) => host.querySelector<HTMLButtonElement>(`[data-testid="composer-send-option-${key}"]`);

  beforeEach(() => {
    localStorage.clear();
    sent = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(suggestReply?: (draft: string) => Promise<ComposerPreview | null>, availableAgents?: Array<'claude' | 'codex'>) {
    await act(async () => {
      root.render(
        <Composer
          spaceName="#growth"
          members={[]}
          agents={own}
          skills={[]}
          onSend={(text, context) => sent.push([text, context])}
          suggestReply={suggestReply}
          availableAgents={availableAgents}
        />
      );
    });
    return host.querySelector<HTMLTextAreaElement>('textarea')!;
  }

  /** Answers like a relay that routes: anything about churn is for your Claude. */
  const routing = () =>
    vi.fn(async (draft: string): Promise<ComposerPreview> => ({ reply: null, route: /churn/.test(draft) ? ASK : NONE }));

  it('reads "Ask Claude" once the preview says ask, and Enter asks Claude like an @mention', async () => {
    const textarea = await render(routing());
    await type(textarea, 'can you check the churn row');
    expect(label()).toContain('Send');
    await vi.waitFor(() => expect(label()).toContain('Ask Claude'));
    // No pill for it: the button says it.
    expect(host.querySelector('[data-testid="composer-pills"]')).toBeNull();
    await pressEnter(textarea);
    expect(sent).toEqual([['can you check the churn row', { replyTo: undefined, agent: 'claude', attach: null }]]);
  });

  it('a suggest, a none or an older relay with no routing all read "Send"', async () => {
    for (const route of [{ action: 'suggest', agent: 'claude' } as ComposerRoute, NONE, null]) {
      const suggestReply = vi.fn(async (): Promise<ComposerPreview> => ({ reply: null, route }));
      const textarea = await render(suggestReply);
      await type(textarea, `lunch at 1? ${String(route?.action)}`);
      await vi.waitFor(() => expect(suggestReply).toHaveBeenCalled());
      await pause(50);
      expect(label()).toContain('Send');
      await type(textarea, '');
    }
  });

  it('keeps the last decision while a newer preview is on its way, and starts over when the draft clears', async () => {
    const answers: Array<(p: ComposerPreview) => void> = [];
    const suggestReply = vi.fn(() => new Promise<ComposerPreview>((resolve) => answers.push(resolve)));
    const textarea = await render(suggestReply);
    await type(textarea, 'check churn');
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => answers[0]!({ reply: null, route: ASK }));
    expect(label()).toContain('Ask Claude');

    // Rewritten: no flicker back to Send while the new answer is out.
    await type(textarea, 'lunch?');
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    await pause(100);
    expect(label()).toContain('Ask Claude');
    await act(async () => answers[1]!({ reply: null, route: NONE }));
    expect(label()).toContain('Send');

    await type(textarea, '');
    await type(textarea, 'x');
    expect(label()).toContain('Send');
  });

  it('the menu offers your agents that can run here, then Send', async () => {
    const textarea = await render(routing(), ['claude']);
    expect(toggle()).toBeNull();
    await type(textarea, 'hello');
    await click(toggle());
    const items = [...host.querySelectorAll('[data-testid="composer-send-menu"] [role="menuitemradio"]')].map((b) => b.textContent);
    expect(items).toEqual(['Ask Claude', 'Send']);
    expect(option('send')!.getAttribute('aria-checked')).toBe('true');
  });

  it('choosing Send while the preview said ask sends plain chat that the router leaves alone', async () => {
    const textarea = await render(routing());
    await type(textarea, 'the churn row looks off');
    await vi.waitFor(() => expect(label()).toContain('Ask Claude'));
    await click(toggle());
    expect(option('claude')!.getAttribute('aria-checked')).toBe('true');
    await click(option('send'));
    expect(host.querySelector('[data-testid="composer-send-menu"]')).toBeNull();
    expect(label()).toContain('Send');
    // The choice sticks for the draft.
    await type(textarea, 'the churn row looks off, fyi');
    await pause(700);
    expect(label()).toContain('Send');
    await pressEnter(textarea);
    expect(sent).toEqual([['the churn row looks off, fyi', { replyTo: undefined, agent: null, attach: null, route: 'none' }]]);
  });

  it('choosing an agent when the preview said none asks it', async () => {
    const suggestReply = routing();
    const textarea = await render(suggestReply);
    await type(textarea, 'summarize the launch thread');
    await vi.waitFor(() => expect(suggestReply).toHaveBeenCalled());
    expect(label()).toContain('Send');
    await click(toggle());
    await click(option('codex'));
    expect(label()).toContain('Ask Codex');
    await pressEnter(textarea);
    expect(sent).toEqual([['summarize the launch thread', { replyTo: undefined, agent: 'codex', attach: null }]]);
    // A fresh draft starts from the preview again.
    await type(textarea, 'x');
    expect(label()).toContain('Send');
  });

  it('an @tag of your agent hides the menu and asks it, as before', async () => {
    const textarea = await render(routing());
    await type(textarea, '@codex the churn row');
    expect(label()).toContain('Ask Codex');
    expect(toggle()).toBeNull();
  });
});

describe('Room — the router\'s private "Ask Claude?"', () => {
  const ME = 'u1';
  const BINDING = 'b-routing';
  type Row = {
    id: string;
    seq: number;
    author: { userId: string; name: string; avatarUrl: null; kind: 'user' };
    kind: string;
    body: string;
    meta: Record<string, unknown> | null;
    createdAt: string;
  };
  const row = (id: string, seq: number, author: string, body: string, meta: Record<string, unknown> | null = null): Row => ({
    id,
    seq,
    author: { userId: author, name: author === ME ? 'Me' : 'Sam', avatarUrl: null, kind: 'user' },
    kind: 'text',
    body,
    meta,
    createdAt: `2026-10-05T09:0${seq}:00Z`,
  });

  let host: HTMLDivElement;
  let root: Root;
  let stored: Row[];
  let posted: Array<{ body: string; meta: Record<string, unknown> | null }>;
  let requested: Array<Record<string, unknown>>;
  let preview: DraftPreview;
  let notify: (payload: Record<string, unknown>) => Promise<void>;

  const suggestion = () => host.querySelector<HTMLButtonElement>('[data-testid="ask-suggestion"]');

  async function open(): Promise<void> {
    const relay = {
      mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      listMembers: async () =>
        ok([
          { userId: ME, clerkUserId: null, name: 'Me', email: null, role: 'owner', avatarUrl: null },
          { userId: 'u2', clerkUserId: null, name: 'Sam', email: null, role: 'editor', avatarUrl: null },
        ]),
      listMessages: async (_b: string, query: { latest?: number; after?: string }) =>
        ok(query.after ? stored.filter((m) => m.seq > Number(query.after)) : stored.slice(-(query.latest ?? 50))),
      getSessionEvents: async () => ok({ run: null as never, events: [] }),
      postMessage: async (_b: string, input: { body: string; meta?: Record<string, unknown> }) => {
        posted.push({ body: input.body, meta: input.meta ?? null });
        const created = row(`p${stored.length + 1}`, stored.length + 1, ME, input.body, input.meta ?? null);
        stored.push(created);
        return ok(created);
      },
      requestOwnAgent: async (_b: string, input: Record<string, unknown>) => {
        requested.push(input);
        return ok({} as never);
      },
      previewDraft: async () => preview,
    };
    let stateless: (data: { payload: string }) => void = () => {};
    const provider = {
      connect: () => {},
      disconnect: () => {},
      destroy: () => {},
      sendStateless: () => {},
      on: (event: string, cb: (data: { payload: string }) => void) => {
        if (event === 'stateless') stateless = cb;
      },
      off: () => {},
      awareness: null,
    };
    notify = (payload) => act(async () => stateless({ payload: JSON.stringify(payload) }));
    roomSourceCache.rememberConnection({ selfUserId: ME, wsUrl: 'wss://relay.test/v1/realtime' });
    const lease = roomSourceCache.acquire(ME, BINDING, () =>
      new RelayRoomSource({
        bindingId: BINDING,
        spaceName: '#growth',
        wsUrl: 'wss://relay.test/v1/realtime',
        selfUserId: ME,
        relay: relay as never,
        connectGraceMs: 10,
        pollIntervalMs: 30,
        createProvider: () => provider,
      })
    );
    await vi.waitFor(() => expect(lease.source.getSnapshot().loaded).toBe(true));
    lease.release();
    await act(async () => root.render(<RoomView bindingId={BINDING} spaceName="#growth" />));
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="message-row"]').length).toBe(stored.length));
  }

  beforeEach(() => {
    localStorage.clear();
    posted = [];
    requested = [];
    preview = { answersTo: null, agent: null, confidence: 0 };
    stored = [row('m1', 1, 'u2', 'Which launch date?'), row('m2', 2, ME, 'can someone pull the churn numbers')];
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

  it('shows under your message, for you only, and one click asks your agent with that message', async () => {
    await open();
    // Someone else's, or malformed: nothing.
    await notify({ type: 'dispatch_suggestion', messageId: 'm2', agent: 'claude', agentId: 'a1', confidence: 0.6, forUserId: 'u2' });
    await notify({ type: 'dispatch_suggestion', messageId: 'm2', agent: 'gemini', agentId: 'a1', confidence: 0.6 });
    expect(suggestion()).toBeNull();

    await notify({ type: 'dispatch_suggestion', messageId: 'm2', agent: 'claude', agentId: 'a1', confidence: 0.6, forUserId: ME });
    await vi.waitFor(() => expect(suggestion()?.textContent).toBe('Ask Claude?'));
    expect(suggestion()!.closest('[data-testid="message-row"]')!.getAttribute('data-mine')).toBe('true');

    await click(suggestion());
    expect(suggestion()).toBeNull();
    await vi.waitFor(() => expect(requested).toHaveLength(1));
    expect(requested[0]).toEqual({
      targetOwnerUserId: ME,
      targetAgent: 'claude',
      prompt: 'can someone pull the churn numbers',
      sourceMessageId: 'm2',
    });
  });

  it('goes away when you send another message', async () => {
    await open();
    await notify({ type: 'dispatch_suggestion', messageId: 'm2', agent: 'codex', agentId: 'a2', confidence: 0.5 });
    await vi.waitFor(() => expect(suggestion()?.textContent).toBe('Ask Codex?'));
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(textarea, 'never mind');
    await pressEnter(textarea);
    expect(suggestion()).toBeNull();
    expect(requested).toHaveLength(0);
  });

  it('a Send chosen over the routing posts the message with route none', async () => {
    preview = {
      answersTo: null,
      agent: null,
      confidence: 0,
      recipient: { kind: 'agent', agentId: 'a1', agent: 'claude', ownerUserId: ME },
      action: 'ask',
    };
    await open();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(textarea, 'the churn row looks off');
    const label = () => host.querySelector('[data-testid="composer-send"]')!.textContent;
    await vi.waitFor(() => expect(label()).toContain('Ask Claude'));
    await click(host.querySelector('[data-testid="composer-send-menu-toggle"]'));
    await click(host.querySelector('[data-testid="composer-send-option-send"]'));
    await pressEnter(textarea);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.meta).toMatchObject({ route: 'none' });
    expect(posted[0]!.meta).not.toHaveProperty('asks');
    expect(requested).toHaveLength(0);
  });

  it('asking from the preview marks the message asked and files the request', async () => {
    preview = {
      answersTo: null,
      agent: null,
      confidence: 0,
      recipient: { kind: 'agent', agentId: 'a1', agent: 'claude', ownerUserId: ME },
      action: 'ask',
    };
    await open();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(textarea, 'pull the churn numbers');
    await vi.waitFor(() => expect(host.querySelector('[data-testid="composer-send"]')!.textContent).toContain('Ask Claude'));
    await pressEnter(textarea);
    await vi.waitFor(() => expect(requested).toHaveLength(1));
    expect(posted[0]!.meta).toMatchObject({ asks: 'claude' });
    expect(posted[0]!.meta).not.toHaveProperty('route');
    expect(requested[0]).toMatchObject({ targetAgent: 'claude', prompt: 'pull the churn numbers', sourceMessageId: 'p3' });
  });
});
