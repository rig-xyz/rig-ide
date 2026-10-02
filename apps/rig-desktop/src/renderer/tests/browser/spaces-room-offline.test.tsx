import { ok } from '@emdash/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A space with the relay out of reach: the same banner as Home (offline /
 * can't reach rig, with "Try again"), and a message sent meanwhile stays in
 * the box — text and files — and goes by itself once the relay answers.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    rig: {
      // Notifications: the Room says which space is on screen and how far it's read.
      notifications: { setViewing: async () => undefined, markSpaceRead: async () => ({ success: true, data: undefined }) },
      spacesConnection: { getConnectionInfo: async () => ({ success: false, error: { message: 'offline' } }) },
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

import { Composer } from '@renderer/features/spaces/components/composer';
import { RoomView } from '@renderer/features/spaces/components/room-view';
import { RelayRoomSource } from '@renderer/features/spaces/relay-room-source';
import { roomSourceCache } from '@renderer/features/spaces/room-source-cache';
import type { ComposerAttachments } from '@renderer/features/spaces/use-composer-attachments';

const state = vi.hoisted(() => ({ online: true }));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => state.online });
});

const fail = { success: false as const, error: { kind: 'relay', message: 'unreachable' } };
const row = (id: string, body: string) => ({
  id,
  seq: 1,
  author: { userId: 'u1', name: 'Alice', avatarUrl: null, kind: 'user' as const },
  kind: 'text',
  body,
  meta: null,
  createdAt: '2026-09-28T09:00:00Z',
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

describe('Room offline', () => {
  let host: HTMLDivElement;
  let root: Root;
  let reachable: boolean;
  let listCalls: number;
  let posted: string[];

  const banner = () => host.querySelector<HTMLElement>('[data-testid="connection-banner"]');

  async function open(): Promise<void> {
    const relay = {
      mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      listMembers: async () => ok([{ userId: 'u1', clerkUserId: null, name: 'Alice', email: null, role: 'owner', avatarUrl: null }]),
      listMessages: async () => {
        listCalls += 1;
        return reachable ? ok([]) : fail;
      },
      getSessionEvents: async () => ok({ run: null as never, events: [] }),
      postMessage: async (_b: string, body: { body?: string }) => {
        posted.push(body.body ?? '');
        return ok(row('m1', body.body ?? ''));
      },
      requestOwnAgent: async () => ok({} as never),
    };
    // The socket never comes up: after the grace the Room polls.
    const quietProvider = { connect: () => {}, disconnect: () => {}, destroy: () => {}, sendStateless: () => {}, on: () => {}, off: () => {}, awareness: null };
    roomSourceCache.rememberConnection({ selfUserId: 'u1', wsUrl: 'wss://relay.test/v1/realtime' });
    const lease = roomSourceCache.acquire('u1', 'b-off', () =>
      new RelayRoomSource({
        bindingId: 'b-off',
        spaceName: '#off',
        wsUrl: 'wss://relay.test/v1/realtime',
        selfUserId: 'u1',
        relay: relay as never,
        connectGraceMs: 10,
        pollIntervalMs: 30,
        createProvider: () => quietProvider,
      })
    );
    await vi.waitFor(() => expect(lease.source.getSnapshot().connection).toBe('offline'));
    lease.release();
    await act(async () => root.render(<RoomView bindingId="b-off" spaceName="#off" />));
  }

  beforeEach(() => {
    state.online = true;
    reachable = false;
    listCalls = 0;
    posted = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    roomSourceCache.clear();
  });

  it("says it can't reach rig, and a message sent meanwhile waits in the box, then goes once rig answers", async () => {
    await open();
    await vi.waitFor(() => expect(banner()?.dataset.variant).toBe('unreachable'));
    expect(banner()?.textContent).toContain("Can't reach rig right now · showing what's on this computer");
    expect(host.querySelector('[data-testid="room-offline"]')).toBeNull();

    const textarea = host.querySelector('textarea')!;
    await type(textarea, 'hello from the train');
    await pressEnter(textarea);
    expect(textarea.value).toBe('hello from the train');
    expect(host.querySelector('[data-testid="composer-waiting-connection"]')?.textContent).toContain(
      "Will send when you're back online"
    );
    expect(posted).toEqual([]);

    reachable = true;
    await vi.waitFor(() => expect(posted).toEqual(['hello from the train']));
    expect(banner()).toBeNull();
    // Socket still down, polls getting through: just the quiet note.
    expect(host.querySelector('[data-testid="room-offline"]')).not.toBeNull();
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('says "offline" with no network, and "Try again" asks the relay now', async () => {
    state.online = false;
    await open();
    await vi.waitFor(() => expect(banner()?.dataset.variant).toBe('offline'));
    expect(banner()?.textContent).toContain("You're offline · showing what's on this computer");

    const before = listCalls;
    const tryAgain = [...banner()!.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!;
    await act(async () => tryAgain.click());
    expect(listCalls).toBeGreaterThan(before);

    reachable = true;
    state.online = true;
    await act(async () => window.dispatchEvent(new Event('online')));
    await vi.waitFor(() => expect(banner()).toBeNull());
  });
});

describe('Composer waiting for the connection', () => {
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

  it('keeps the text and the files, never clearing (committing) them, until the connection is back', async () => {
    const chip = { id: 'c1', source: '/Users/me/plan.pdf', size: 10 };
    const attachments = {
      chips: [chip],
      disabledReason: null,
      pending: false,
      ready: true,
      holdReason: null,
      clear: vi.fn(() => [chip]),
    } as unknown as ComposerAttachments;
    const onSend = vi.fn();
    const render = (waitForConnection: boolean) =>
      act(async () =>
        root.render(
          <Composer
            spaceName="#off"
            members={[]}
            agents={[]}
            skills={[]}
            onSend={onSend}
            attachments={attachments}
            waitForConnection={waitForConnection}
          />
        )
      );
    await render(true);
    const textarea = host.querySelector('textarea')!;
    await type(textarea, 'the plan');
    await pressEnter(textarea);
    expect(onSend).not.toHaveBeenCalled();
    expect(attachments.clear).not.toHaveBeenCalled();
    expect(textarea.value).toBe('the plan');

    // "Don't send" drops the wait but keeps the draft.
    const dontSend = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Don’t send')!;
    await act(async () => dontSend.click());
    expect(host.querySelector('[data-testid="composer-waiting-connection"]')).toBeNull();
    await render(false);
    expect(onSend).not.toHaveBeenCalled();

    await render(true);
    await pressEnter(textarea);
    await render(false);
    expect(attachments.clear).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('the plan', expect.objectContaining({ files: [chip] }));
  });
});
