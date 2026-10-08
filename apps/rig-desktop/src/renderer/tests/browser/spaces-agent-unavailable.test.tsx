import { ok } from '@emdash/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tagging an agent this Mac can't run: the message goes as plain chat (and
 * the router is told to leave it), the composer says the agent isn't set up
 * here, and Set up opens the install offer. No request is ever filed.
 */

const ICON = { kind: 'svg' as const, variants: [{ minSize: 0, light: 'data:image/svg+xml,<svg/>' }] };
const NO_AUTH = { auth: { kind: 'unsupported' } };
const install = vi.fn(async () => ({ success: true, data: {} }));
/** What GET /v1/me/agents says your other Macs have; a rejection is a relay that can't say. */
const otherMacs = vi.fn(async (): Promise<{ agents: string[] } | null> => ({ agents: [] }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    // Neither agent is set up on this Mac.
    agents: {
      list: async () => [
        {
          id: 'claude',
          name: 'Claude Code',
          status: 'missing',
          icon: ICON,
          capabilities: NO_AUTH,
          installOptions: [{ method: 'curl', command: 'curl -fsSL https://claude.ai/install.sh | bash', recommended: true }],
        },
        { id: 'codex', name: 'Codex', status: 'missing', icon: ICON, capabilities: NO_AUTH, installOptions: [] },
      ],
      install: (...args: unknown[]) => install(...(args as [])),
      probeAll: async () => undefined,
    },
    rig: {
      settings: { get: async () => ({ spacesChatView: 'flow' }), set: async () => ({}) },
      notifications: { setViewing: async () => undefined, markSpaceRead: async () => ({ success: true, data: undefined }) },
      spacesConnection: {
        getConnectionInfo: async () => ({ success: false, error: { message: 'offline' } }),
        log: async () => undefined,
      },
      spacesDispatch: {
        checkNow: async () => undefined,
        settleStaleRun: async () => ({ settled: true }),
        otherMacsAgents: () => otherMacs(),
      },
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

describe('Room — an agent that isn’t set up on this Mac', () => {
  const ME = 'u1';
  const BINDING = 'b-unavailable';
  type Row = {
    id: string;
    seq: number;
    author: { userId: string; name: string; avatarUrl: null; kind: 'user' };
    kind: string;
    body: string;
    meta: Record<string, unknown> | null;
    createdAt: string;
  };
  const row = (id: string, seq: number, body: string, meta: Record<string, unknown> | null = null): Row => ({
    id,
    seq,
    author: { userId: ME, name: 'Me', avatarUrl: null, kind: 'user' },
    kind: 'text',
    body,
    meta,
    createdAt: `2026-10-07T09:0${seq}:00Z`,
  });

  let host: HTMLDivElement;
  let root: Root;
  let stored: Row[];
  let posted: Array<{ body: string; meta: Record<string, unknown> | null }>;
  let requested: Array<Record<string, unknown>>;

  async function open(): Promise<void> {
    const relay = {
      mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      listMembers: async () => ok([{ userId: ME, clerkUserId: null, name: 'Me', email: null, role: 'owner', avatarUrl: null }]),
      listMessages: async (_b: string, query: { latest?: number; after?: string }) =>
        ok(query.after ? stored.filter((m) => m.seq > Number(query.after)) : stored.slice(-(query.latest ?? 50))),
      getSessionEvents: async () => ok({ run: null as never, events: [] }),
      postMessage: async (_b: string, input: { body: string; meta?: Record<string, unknown> }) => {
        posted.push({ body: input.body, meta: input.meta ?? null });
        const created = row(`p${stored.length + 1}`, stored.length + 1, input.body, input.meta ?? null);
        stored.push(created);
        return ok(created);
      },
      requestOwnAgent: async (_b: string, input: Record<string, unknown>) => {
        requested.push(input);
        return ok({} as never);
      },
      previewDraft: async () => ({ answersTo: null, agent: null, confidence: 0 }),
    };
    const provider = {
      connect: () => {},
      disconnect: () => {},
      destroy: () => {},
      sendStateless: () => {},
      on: () => {},
      off: () => {},
      awareness: null,
    };
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
    install.mockClear();
    otherMacs.mockReset().mockResolvedValue({ agents: [] });
    stored = [row('m1', 1, 'notes from the call')];
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

  it('says Claude isn’t set up, sends @claude hi as plain chat, and files no request', async () => {
    await open();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(textarea, '@claude hi');
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="composer-agent-unavailable"]')?.textContent).toContain(
        'Claude isn’t set up on this Mac.'
      )
    );
    expect(host.querySelector('[data-testid="composer-send"]')!.textContent).toContain('Send');
    await pressEnter(textarea);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toBe('@claude hi');
    expect(posted[0]!.meta).toMatchObject({ route: 'none' });
    expect(posted[0]!.meta).not.toHaveProperty('asks');
    await new Promise((r) => setTimeout(r, 50));
    expect(requested).toHaveLength(0);
  });

  it('offers no agent in the @ menu, and Set up opens the install offer', async () => {
    await open();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(textarea, '@cl');
    expect(host.querySelector('[data-testid="mention-palette"]')).toBeNull();

    await type(textarea, '@claude can you summarize');
    await click(await vi.waitFor(() => host.ownerDocument.querySelector('[data-testid="composer-set-up-agent"]')));
    const dialog = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="agent-setup-dialog"]');
      expect(el?.querySelector('[data-testid="agent-install-row"][data-agent-id="claude"]')).not.toBeNull();
      return el!;
    });
    expect(dialog.textContent).toContain('Set up Claude');
    await click(dialog.querySelector('[data-testid="agent-install-curl"]'));
    await vi.waitFor(() => expect(install).toHaveBeenCalledWith('claude', undefined, 'curl'));
  });

  it('asks Claude anyway when your other Mac has it, and says it runs there', async () => {
    otherMacs.mockResolvedValue({ agents: ['claude'] });
    await open();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(textarea, '@claude hi');
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="composer-agent-elsewhere"]')?.textContent).toBe(
        'Claude will run on your other Mac.'
      )
    );
    expect(host.querySelector('[data-testid="composer-agent-unavailable"]')).toBeNull();
    await pressEnter(textarea);
    await vi.waitFor(() => expect(requested).toHaveLength(1));
    expect(requested[0]).toMatchObject({ targetAgent: 'claude', targetOwnerUserId: ME });
    expect(posted[0]!.meta).toMatchObject({ asks: 'claude' });
  });

  it('files the request when the relay can’t say what your other Macs have', async () => {
    otherMacs.mockRejectedValue(new Error('offline'));
    await open();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(textarea, '@claude hi');
    await new Promise((r) => setTimeout(r, 30));
    expect(host.querySelector('[data-testid="composer-agent-unavailable"]')).toBeNull();
    await pressEnter(textarea);
    await vi.waitFor(() => expect(requested).toHaveLength(1));
  });
});
