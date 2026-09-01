import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocCommentsStore } from '@renderer/features/docs/comments/comments-store';
import { DocTabResource } from '@renderer/features/docs/doc-file-sync';
import { rigCommentAgentProgressChannel, type RigCommentMessage } from '@shared/rig/comments';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(data: unknown) => void>>(),
  askAgent: vi.fn<(input: unknown) => Promise<unknown>>(),
  commentsCreate: vi.fn<(input: unknown) => Promise<unknown>>(),
  commentsList: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      files: {
        read: vi.fn(async () => ({
          success: true,
          data: { content: '# Forecast\n\nThe Q3 forecast is $4.2m.\n', truncated: false },
        })),
        write: vi.fn(async () => ({ success: true, data: undefined })),
        watch: vi.fn(async () => ({ success: true, data: undefined })),
        unwatch: vi.fn(async () => ({ success: true, data: undefined })),
      },
      comments: {
        cacheGet: vi.fn(async () => null),
        cacheSet: vi.fn(async () => ({ success: true, data: undefined })),
        resolveTarget: vi.fn(async () => ({
          success: true,
          data: {
            target: {
              bindingId: 'bnd_test',
              relayUrl: 'https://relay.example',
              relPath: 'docs/forecast.md',
            },
            selfUserId: 'user-1',
          },
        })),
        list: (...args: unknown[]) => mocks.commentsList(args[0]),
        create: (...args: unknown[]) => mocks.commentsCreate(args[0]),
        askAgent: (...args: unknown[]) => mocks.askAgent(args[0]),
      },
    },
  },
  events: {
    on: (event: { name: string }, callback: (data: unknown) => void) => {
      const listeners = mocks.listeners.get(event.name) ?? new Set();
      listeners.add(callback);
      mocks.listeners.set(event.name, listeners);
      return () => listeners.delete(callback);
    },
  },
}));

const root: RigCommentMessage = {
  id: 'msg-root',
  seq: '1',
  bindingId: 'bnd_test',
  author: { userId: 'user-1', name: 'Dylan', avatarUrl: null, kind: 'user' },
  kind: 'text',
  body: '@codex why is this here?',
  parentId: null,
  intentId: null,
  path: 'docs/forecast.md',
  meta: null,
  anchor: { exact: 'The Q3 forecast is $4.2m.', prefix: '# Forecast\n\n', suffix: '\n' },
  resolvedAt: null,
  resolvedBy: null,
  createdAt: '2026-08-31T15:00:00.000Z',
  editedAt: null,
  deletedAt: null,
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error('waitFor timed out');
}

describe('comment agent streaming', () => {
  let resource: DocTabResource;
  let store: DocCommentsStore;
  let settleAgent: (value: unknown) => void;

  beforeEach(async () => {
    mocks.listeners.clear();
    mocks.commentsCreate.mockReset().mockResolvedValue({ success: true, data: root });
    mocks.commentsList.mockReset().mockResolvedValue({
      success: true,
      data: { messages: [root] },
    });
    mocks.askAgent.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          settleAgent = resolve;
        })
    );
    resource = new DocTabResource(
      { path: '/repo/docs/forecast.md' },
      { root: '/repo', rootId: 'root-1' }
    );
    store = new DocCommentsStore(resource);
    await waitFor(() => !resource.isLoading && store.target !== null);
  });

  afterEach(() => {
    store.dispose();
    resource.dispose();
  });

  it('projects live assistant prose into the pending thread and preserves it on failure', async () => {
    await store.create(root.anchor!.exact, root.body, { providerId: 'codex', name: 'Codex' });
    await waitFor(() => store.agentReplyFor(root.id) !== null);

    for (const listener of mocks.listeners.get(rigCommentAgentProgressChannel.name) ?? []) {
      listener({
        absPath: resource.path,
        rootId: root.id,
        activity: 'writing',
        text: 'The recorded intent was',
      });
    }

    expect(store.agentReplyFor(root.id)).toMatchObject({
      activity: 'writing',
      text: 'The recorded intent was',
      error: null,
    });

    settleAgent({
      success: false,
      error: { kind: 'agent', message: 'The agent connection closed.' },
    });
    await waitFor(() => store.agentReplyFor(root.id)?.error !== null);
    expect(store.agentReplyFor(root.id)).toMatchObject({
      text: 'The recorded intent was',
      error: 'The agent connection closed.',
    });
  });
});
