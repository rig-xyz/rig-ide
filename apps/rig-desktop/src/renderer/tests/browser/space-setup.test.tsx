import { ok } from '@emdash/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceSetup, SpaceSetupEvent } from '@shared/rig/space-setup';

/**
 * Instant new space: the Room opens at once under the space's name while
 * main sets it up. The composer works (a message sent before the space is
 * live waits, then posts from the same Room once it is — no remount),
 * Attach waits with a reason, a failure is inline with Retry and "Remove
 * it", and Home lists a space still being set up.
 */

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  setupListener: null as null | ((event: unknown) => void),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    rig: {
      spacesConnection: {
        getConnectionInfo: async () => ({ success: false, error: { message: 'offline' } }),
        listMembers: async () => ({ success: true, data: [] }),
      },
      attachments: { prepare: async () => ({ space: { status: 'ok' }, files: [] }) },
      recent: { resolveLocalPaths: async () => ({}) },
      spaceSetup: {
        start: (...args: unknown[]) => mocks.start(...args),
        list: async () => [],
        retry: async () => null,
        remove: async () => ({ removedFolder: true }),
      },
    },
  },
  events: {
    on: (channel: { name: string }, listener: (event: unknown) => void) => {
      if (channel.name === 'rig:space-setup') mocks.setupListener = listener;
      return () => {};
    },
  },
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

import { SpacesCard } from '@renderer/features/home/spaces-card';
import { RoomView } from '@renderer/features/spaces/components/room-view';
import type { RoomSetup } from '@renderer/features/spaces/components/space-setup-state';
import { RelayRoomSource } from '@renderer/features/spaces/relay-room-source';
import { roomSourceCache } from '@renderer/features/spaces/room-source-cache';
import {
  onOpenSetupRequest,
  setupDraftKey,
  startSpaceSetup,
  useSpaceSetups,
} from '@renderer/features/spaces/space-setup-store';

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

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const setupOf = (overrides: Partial<RoomSetup> = {}): RoomSetup => ({
  id: 's1',
  status: 'working',
  error: null,
  removable: true,
  onRetry: vi.fn(),
  onRemove: vi.fn(),
  ...overrides,
});

const row = (id: string, body: string) => ({
  id,
  seq: 1,
  author: { userId: 'u1', name: 'Me', avatarUrl: null, kind: 'user' as const },
  kind: 'text',
  body,
  meta: null,
  createdAt: '2026-09-30T09:00:00Z',
});

describe('The Room of a space still being set up', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    roomSourceCache.clear();
  });

  it('opens at once under its name; a message sent now waits, then posts from the same Room once it is live', async () => {
    await act(async () => root.render(<RoomView bindingId="" spaceName="#bright-harbor" setup={setupOf()} />));

    const body = host.querySelector('[data-testid="space-setup"]');
    expect(body?.textContent).toContain('#bright-harbor');
    expect(body?.textContent).toContain('Setting up your space…');
    expect(body?.querySelector('[data-state="starting"]')).not.toBeNull();

    // Attach waits, and says why.
    const attach = host.querySelector<HTMLButtonElement>('[data-testid="composer-attach"]')!;
    expect(attach.getAttribute('aria-disabled')).toBe('true');
    expect(attach.title).toBe('Available in a moment…');

    const textarea = host.querySelector('textarea')!;
    expect(textarea.placeholder).toBe('Message #bright-harbor');
    await type(textarea, 'hello, new space');
    await pressEnter(textarea);
    expect(textarea.value).toBe('hello, new space');
    expect(host.querySelector('[data-testid="composer-waiting-connection"]')?.textContent).toContain(
      'Sends once the space is ready.'
    );

    // Live: App hands over the binding id. The relay room is there.
    const posted: string[] = [];
    const relay = {
      mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
      listMembers: async () => ok([{ userId: 'u1', clerkUserId: null, name: 'Me', email: null, role: 'owner', avatarUrl: null }]),
      listMessages: async () => ok(posted.map((text, i) => row(`m${i + 1}`, text))),
      getSessionEvents: async () => ok({ run: null as never, events: [] }),
      postMessage: async (_b: string, input: { body?: string }) => {
        posted.push(input.body ?? '');
        return ok(row(`m${posted.length}`, input.body ?? ''));
      },
      requestOwnAgent: async () => ok({} as never),
    };
    const quietProvider = { connect: () => {}, disconnect: () => {}, destroy: () => {}, sendStateless: () => {}, on: () => {}, off: () => {}, awareness: null };
    roomSourceCache.rememberConnection({ selfUserId: 'u1', wsUrl: 'wss://relay.test/v1/realtime' });
    roomSourceCache
      .acquire('u1', 'b-new', () =>
        new RelayRoomSource({
          bindingId: 'b-new',
          spaceName: '#bright-harbor',
          wsUrl: 'wss://relay.test/v1/realtime',
          selfUserId: 'u1',
          relay: relay as never,
          connectGraceMs: 10,
          pollIntervalMs: 30,
          createProvider: () => quietProvider,
        })
      )
      .release();
    // Nothing went out before the space was live.
    expect(posted).toEqual([]);

    await act(async () => root.render(<RoomView bindingId="b-new" spaceName="#bright-harbor" setup={null} />));
    await vi.waitFor(() => expect(posted).toEqual(['hello, new space']));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="space-setup"]')).toBeNull());
    // The same composer (no remount), now empty; the message is in the Room.
    expect(host.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('');
    await vi.waitFor(() => expect(host.textContent).toContain('hello, new space'));
    expect(attach.isConnected).toBe(true);
    expect(attach.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('a failure is inline, with Retry and "Remove it"', async () => {
    const setup = setupOf({ status: 'failed', error: "Can't reach the relay at https://tap-relay.fly.dev." });
    await act(async () => root.render(<RoomView bindingId="" spaceName="#bright-harbor" setup={setup} />));

    const failed = host.querySelector('[data-testid="space-setup-failed"]');
    expect(failed?.getAttribute('role')).toBe('alert');
    expect(failed?.textContent).toContain('#bright-harbor couldn’t be set up');
    expect(failed?.textContent).toContain("Can't reach the relay at https://tap-relay.fly.dev.");
    const button = (text: string) => [...failed!.querySelectorAll('button')].find((b) => b.textContent === text)!;
    await act(async () => click(button('Retry')));
    expect(setup.onRetry).toHaveBeenCalledTimes(1);
    await act(async () => click(button('Remove it')));
    expect(setup.onRemove).toHaveBeenCalledTimes(1);
    // The composer is still there: never a dead end.
    expect(host.querySelector('textarea')).not.toBeNull();
  });

  it('back to setting up after Retry', async () => {
    await act(async () =>
      root.render(<RoomView bindingId="" spaceName="#s" setup={setupOf({ status: 'failed', error: 'x' })} />)
    );
    await act(async () => root.render(<RoomView bindingId="" spaceName="#s" setup={setupOf({ status: 'working' })} />));
    expect(host.querySelector('[data-testid="space-setup-failed"]')).toBeNull();
    expect(host.querySelector('[data-testid="space-setup"]')).not.toBeNull();
  });
});

describe('Home while a space is being set up', () => {
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

  const setup = (overrides: Partial<SpaceSetup>): SpaceSetup => ({
    id: 's1',
    name: 'bright-harbor',
    path: '/Users/me/Rig/bright-harbor',
    status: 'working',
    step: 'goingLive',
    bindingId: null,
    homeUrl: null,
    error: null,
    removable: true,
    ...overrides,
  });

  it('lists it with "Setting up…" (or why it failed), and a click opens its Room', async () => {
    const onOpenSetup = vi.fn();
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SpacesCard
            rows={[]}
            settingUp={[
              setup({}),
              setup({ id: 's2', name: 'calm-river', status: 'failed', error: { code: 'error', message: 'x' } }),
            ]}
            onOpenSetup={onOpenSetup}
            statusByBinding={new Map()}
            selfUserId={null}
            onOpenPath={() => {}}
          />
        </QueryClientProvider>
      )
    );
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="space-setup-row"]')];
    expect(rows.map((r) => r.textContent)).toEqual(['#bright-harborSetting up…', '#calm-riverCouldn’t finish setting up']);
    expect(rows[0]?.querySelector('[data-state="starting"]')).not.toBeNull();
    // Not the empty card's line while one is on its way.
    expect(host.textContent).not.toContain('A space for your team and your agents.');
    await act(async () => click(rows[1]!));
    expect(onOpenSetup).toHaveBeenCalledWith('s2');
  });
});

describe('space setup store', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('"New space" starts the setup and asks for its Room; live moves the draft to the space', async () => {
    const started: SpaceSetup = {
      id: 'sx',
      name: 'quiet-grove',
      path: '/Users/me/Rig/quiet-grove',
      status: 'working',
      step: 'goingLive',
      bindingId: null,
      homeUrl: null,
      error: null,
      removable: true,
    };
    mocks.start.mockResolvedValue({ success: true, data: started });
    let seen: ReadonlyMap<string, SpaceSetup> = new Map();
    function Probe() {
      seen = useSpaceSetups();
      return null;
    }
    await act(async () => root.render(<Probe />));
    const opened: string[] = [];
    const off = onOpenSetupRequest((id) => opened.push(id));

    await act(async () => expect(await startSpaceSetup('quiet-grove')).toBeNull());
    expect(mocks.start).toHaveBeenCalledWith({ name: 'quiet-grove' });
    expect(opened).toEqual(['sx']);
    expect(seen.get('sx')?.status).toBe('working');

    // Typed in the Room meanwhile (the composer keeps it under the setup's key).
    localStorage.setItem(`rig-room-draft:${setupDraftKey('sx')}`, 'first words');
    const live: SpaceSetupEvent = { ...started, status: 'live', step: 'live', bindingId: 'b-q', removable: false };
    await act(async () => mocks.setupListener?.(live));
    expect(seen.get('sx')?.status).toBe('live');
    expect(localStorage.getItem('rig-room-draft:b-q')).toBe('first words');
    expect(localStorage.getItem(`rig-room-draft:${setupDraftKey('sx')}`)).toBeNull();

    await act(async () => mocks.setupListener?.({ ...live, removed: true }));
    expect(seen.has('sx')).toBe(false);
    off();
  });

  it('a folder that could not even be made says why, and opens nothing', async () => {
    mocks.start.mockResolvedValue({ success: false, error: { kind: 'initFailed', message: 'Could not create the folder: EACCES' } });
    const opened: string[] = [];
    const off = onOpenSetupRequest((id) => opened.push(id));
    expect(await startSpaceSetup('x')).toBe('Could not create the folder: EACCES');
    expect(opened).toEqual([]);
    off();
  });
});
