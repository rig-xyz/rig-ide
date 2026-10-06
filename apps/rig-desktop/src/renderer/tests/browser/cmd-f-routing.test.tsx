import { ok } from '@emdash/shared';
import { searchPanelOpen } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cmd-F goes to the pane you're in. A space's chat beside a doc, the way
 * App lays them out (each pane marked, the last one touched remembered):
 * clicking the doc's reading view moves no focus, so the body still has
 * it, and Cmd-F must find in the doc; clicking the chat sends it back to
 * the chat's search. Only one of them ever answers.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {}, openPath: async () => {}, showItemInFolder: async () => {} },
    agents: { list: async () => [], listMetadata: async () => [] },
    rig: {
      settings: { get: async () => ({ spacesChatView: 'flow' }), set: async () => ({ success: true, data: undefined }) },
      notifications: { setViewing: async () => undefined, markSpaceRead: async () => ({ success: true, data: undefined }) },
      spacesConnection: {
        getConnectionInfo: async () => ({ success: false, error: { message: 'offline' } }),
        log: async () => undefined,
      },
      spacesDispatch: { checkNow: async () => undefined, settleStaleRun: async () => ({ settled: true }) },
      attachments: { prepare: async () => ({ space: { status: 'ok' }, files: [] }) },
      recent: { resolveLocalPaths: async () => ({}) },
      files: {
        read: async () => ({ success: true, data: { content: '# Plan\n\nThe pricing plan.\n', truncated: false } }),
        write: async () => ({ success: true, data: undefined }),
        watch: () => {},
        unwatch: () => {},
        readBinary: async () => ({ success: false, error: { message: 'none' } }),
      },
      comments: {
        cacheGet: async () => null,
        cacheSet: async () => ({ success: true, data: undefined }),
        resolveTarget: async () => ({ success: false, error: { kind: 'notBound', message: 'Not bound' } }),
        list: async () => ({ success: true, data: { messages: [] } }),
        create: async () => ({ success: false, error: { message: 'no' } }),
        listMembers: async () => ({ success: true, data: { members: [] } }),
      },
      context: { createTarget: async () => ({ success: true, data: { targetRef: 't' } }) },
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

import { ArtifactView } from '@renderer/features/artifact/artifact-view';
import { resetPreviewModeMemoryForTests, setPreviewMode } from '@renderer/features/artifact/preview-mode-memory';
import { CmdFRouteContext, type CmdFRoute } from '@renderer/features/shell/cmd-f-target';
import type { RigLayout } from '@renderer/features/shell/layout-switcher';
import type { FocusedRigPane } from '@renderer/features/shell/native-close-target';
import { RoomView } from '@renderer/features/spaces/components/room-view';
import { RelayRoomSource } from '@renderer/features/spaces/relay-room-source';
import { roomSourceCache } from '@renderer/features/spaces/room-source-cache';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const ME = 'u1';
const BINDING = 'b-route';
const DOC = '/repo/plan.md';

function row(id: string, seq: number, body: string) {
  return {
    id,
    seq,
    author: { userId: 'u2', name: 'Sam', avatarUrl: null, kind: 'user' as const },
    kind: 'text',
    body,
    meta: null,
    createdAt: new Date(Date.UTC(2026, 9, 5, 9, seq)).toISOString(),
  };
}
const STORED = [row('m1', 1, 'Pricing is on the agenda'), row('m2', 2, 'See the plan doc')];

async function startRoom(): Promise<void> {
  const relay = {
    mintRealtimeTicket: async () => ok({ ticket: 't', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    listMembers: async () =>
      ok([{ userId: 'u2', clerkUserId: null, name: 'Sam', email: null, role: 'owner', avatarUrl: null }]),
    listMessages: async (_b: string, query: { after?: string }) =>
      ok(query.after ? STORED.filter((m) => m.seq > Number(query.after)) : STORED),
    getSessionEvents: async () => ok({ run: null, events: [] }),
    searchMessages: async () => ok({ results: [], nextBefore: null }),
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
  lease.release();
}

/** App's two panes, as App marks them and remembers the last one touched. */
function Split({ layout = 'split' }: { layout?: RigLayout }) {
  const [lastPane, setLastPane] = useState<FocusedRigPane>('chat');
  const route = useRef<CmdFRoute>({ layout, lastPane });
  useEffect(() => {
    route.current = { layout, lastPane };
  }, [layout, lastPane]);
  const getRoute = useCallback(() => route.current, []);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <CmdFRouteContext.Provider value={getRoute}>
        <div style={{ display: 'flex', height: 700 }}>
          <div
            data-rig-pane="chat"
            data-testid="chat-pane"
            style={{ width: 500, position: 'relative', display: 'flex', flexDirection: 'column' }}
            onPointerDownCapture={() => setLastPane('chat')}
            onFocusCapture={() => setLastPane('chat')}
          >
            <RoomView bindingId={BINDING} spaceName="#launch" split />
          </div>
          <div
            data-rig-pane="artifact"
            style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
            onPointerDownCapture={() => setLastPane('artifact')}
            onFocusCapture={() => setLastPane('artifact')}
          >
            <ArtifactView root="/repo" rootId="repo-1" path={DOC} onNavigateFolder={() => {}} />
          </div>
        </div>
      </CmdFRouteContext.Provider>
    </QueryClientProvider>
  );
}

async function cmdF(): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
  await act(async () => {
    document.body.dispatchEvent(event);
  });
  return event;
}

async function pointerDown(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('Cmd-F in a space beside a doc', () => {
  let host: HTMLDivElement;
  let root: Root;

  const chatSearch = () => host.querySelector('[data-testid="chat-search"]');
  const docFind = () => host.querySelector('[data-testid="reading-find"]');
  const docText = () =>
    Array.from(host.querySelectorAll('p')).find((p) => p.textContent === 'The pricing plan.') ?? null;
  const transcript = () => host.querySelector('[data-testid="room-transcript"]')!;

  beforeEach(async () => {
    localStorage.clear();
    resetPreviewModeMemoryForTests();
    host = document.createElement('div');
    host.style.width = '1200px';
    document.body.appendChild(host);
    root = createRoot(host);
    await startRoom();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    roomSourceCache.clear();
  });

  async function render(layout?: RigLayout) {
    await act(async () => root.render(<Split layout={layout} />));
    await vi.waitFor(() => expect(transcript().querySelector('[data-message-id="m2"]')).not.toBeNull());
    await vi.waitFor(() => expect(docText()).not.toBeNull());
  }

  it('finds in the doc after a click in its reading view, and searches the chat after a click in the chat', async () => {
    await render();
    await pointerDown(docText()!);
    // A click in rendered text moves no focus: the body still has it.
    expect(document.activeElement).toBe(document.body);
    const first = await cmdF();
    expect(first.defaultPrevented).toBe(true);
    expect(docFind()).not.toBeNull();
    expect(chatSearch()).toBeNull();

    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await pointerDown(transcript().querySelector('[data-message-id="m1"]')!);
    await cmdF();
    expect(chatSearch()).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="chat-search-input"]'));
  });

  it('searches the chat from its composer, wherever was clicked last', async () => {
    await render();
    await pointerDown(docText()!);
    const composer = host.querySelector<HTMLElement>('[data-testid="chat-pane"] [contenteditable="true"], [data-testid="chat-pane"] textarea');
    expect(composer).not.toBeNull();
    await act(async () => composer!.focus());
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => void composer!.dispatchEvent(event));
    expect(chatSearch()).not.toBeNull();
    expect(docFind()).toBeNull();
  });

  it('opens the editor’s own find when the doc is being edited', async () => {
    setPreviewMode(DOC, 'edit');
    await act(async () => root.render(<Split />));
    await vi.waitFor(() => expect(host.querySelector('.cm-editor')).not.toBeNull());
    await vi.waitFor(() => expect(transcript().querySelector('[data-message-id="m2"]')).not.toBeNull());
    // The doc's title bar: in the doc's pane, outside the editor.
    await pointerDown(host.querySelector('[data-rig-pane="artifact"] [title="/repo/plan.md"]')!);
    await cmdF();
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(chatSearch()).toBeNull();
  });

  it('is always the doc in the Doc layout', async () => {
    await act(async () => root.render(<Split layout="files" />));
    await vi.waitFor(() => expect(docText()).not.toBeNull());
    await cmdF();
    expect(docFind()).not.toBeNull();
    expect(chatSearch()).toBeNull();
  });
});
