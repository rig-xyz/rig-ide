import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTree, rigFilesQueryKey } from '@renderer/features/workspace/file-tree';
import type { RigFileNode } from '@shared/rig/files';

/**
 * Regression coverage for the live file-tree bug (post-release usage
 * round, Dylan): an agent created a file mid-session and the tree never
 * showed it until navigating Home and back. Root cause — confirmed by
 * reading the code, not guessing: `main/rig/files.ts` already runs a real,
 * debounced `node:fs.watch(root, {recursive:true})` and emits
 * `rigFileChangeChannel` on every change (`doc-file-sync.ts`'s absorb path
 * has used it since day one); `FileTree` just never subscribed — it only
 * ever did a one-shot `useQuery` on mount, so the listing only refreshed
 * when something else (a full remount) happened to refetch it.
 *
 * This pins the fix: `FileTree` now calls `rpc.rig.files.watch({ rootId })` and
 * listens for `rigFileChangeChannel`, invalidating its query (triggering a
 * real refetch through the same mocked `rpc.rig.files.list`) whenever the
 * event's root ID matches — and does NOT refetch for a change reported under
 * a different root capability.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn<(args: { rootId: string }) => Promise<unknown>>(),
  watch: vi.fn<(args: { rootId: string }) => void>(),
  unwatch: vi.fn<(args: { rootId: string }) => void>(),
}));

let fileChangeListener: ((data: { rootId: string }) => void) | null = null;

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      files: {
        list: (...args: unknown[]) => mocks.list(...(args as [{ rootId: string }])),
        watch: (...args: unknown[]) => mocks.watch(...(args as [{ rootId: string }])),
        unwatch: (...args: unknown[]) => mocks.unwatch(...(args as [{ rootId: string }])),
      },
    },
  },
  events: {
    on: (_channel: unknown, cb: (data: { rootId: string }) => void) => {
      fileChangeListener = cb;
      return () => {
        fileChangeListener = null;
      };
    },
  },
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function fileNode(name: string): RigFileNode {
  return { name, relPath: name, kind: 'file' };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error('waitFor timed out');
}

describe('FileTree — live updates on disk change', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    queryClient = new QueryClient();
    root = createRoot(host);
    mocks.list.mockReset();
    mocks.watch.mockReset();
    mocks.unwatch.mockReset();
    fileChangeListener = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    queryClient.clear();
  });

  it('keeps reopened-root capabilities in separate listing cache entries', () => {
    expect(rigFilesQueryKey('/rig', 'root-1')).not.toEqual(rigFilesQueryKey('/rig', 'root-2'));
  });

  it('refetches the listing when rigFileChangeChannel reports a change for this root (the agent-created-file case)', async () => {
    mocks.list
      .mockResolvedValueOnce({ success: true, data: [fileNode('alpha.md')] })
      .mockResolvedValueOnce({ success: true, data: [fileNode('alpha.md'), fileNode('beta.md')] });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <FileTree root="/rig" rootId="rig-1" activePath={null} onOpenFile={() => {}} />
        </QueryClientProvider>
      );
    });

    await waitFor(() => host.textContent?.includes('alpha') ?? false);
    expect(host.textContent).not.toContain('beta');
    expect(mocks.watch).toHaveBeenCalledWith({ rootId: 'rig-1' });

    // Simulate the main-process watcher firing for this exact root.
    await act(async () => {
      fileChangeListener?.({ rootId: 'rig-1' });
    });

    await waitFor(() => host.textContent?.includes('beta') ?? false);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('ignores a change reported for a different root', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [fileNode('alpha.md')] });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <FileTree root="/rig" rootId="rig-1" activePath={null} onOpenFile={() => {}} />
        </QueryClientProvider>
      );
    });

    await waitFor(() => host.textContent?.includes('alpha') ?? false);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      fileChangeListener?.({ rootId: 'other' });
    });
    // No predicate to wait on for "nothing happened" — a fixed settle
    // window is the honest way to assert a non-event actually didn't fire.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('unwatches on unmount', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [fileNode('alpha.md')] });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <FileTree root="/rig" rootId="rig-1" activePath={null} onOpenFile={() => {}} />
        </QueryClientProvider>
      );
    });
    await waitFor(() => host.textContent?.includes('alpha') ?? false);

    await act(async () => root.unmount());
    expect(mocks.unwatch).toHaveBeenCalledWith({ rootId: 'rig-1' });
  });
});
