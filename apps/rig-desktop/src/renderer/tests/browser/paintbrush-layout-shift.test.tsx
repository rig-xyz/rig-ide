import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactView } from '@renderer/features/artifact/artifact-view';
import { resetPreviewModeMemoryForTests } from '@renderer/features/artifact/preview-mode-memory';
// Real tokens, not a stub — see `artifact-view.test.tsx`'s own note on why.
import '@renderer/tokens.css';

/**
 * Regression coverage for the paintbrush v1.1 layout-shift report ("arming
 * the mode / streaming bumps the sides of the editor so it jumps around" —
 * `docs/document-focus-design.md` §2 punch list, finding 2). Every v1.1
 * addition to the document container (the inset ring, the coach-mark
 * popover, the cursor chip, the card beam) is required to be either
 * `box-shadow`-based, portaled, or otherwise incapable of changing this
 * container's own box — this pins that: toggling the mode must not touch
 * the container's inline style, its computed padding/border/outline, or
 * its list of direct children.
 *
 * jsdom (this harness) can verify DOM structure and computed style, not
 * real layout/reflow — genuine pixel-level layout-shift is reviewed by
 * hand against the CSS instead (see the round's own report). This test's
 * job is the part jsdom CAN prove: nothing here ever had a reason to
 * change the container's box model or insert a sibling into its scroll
 * area, and this keeps that true.
 */

const mocks = vi.hoisted(() => ({
  read: vi.fn<(args: unknown) => Promise<unknown>>(),
  write: vi.fn<(args: unknown) => Promise<unknown>>(),
  watch: vi.fn<(args: unknown) => void>(),
  unwatch: vi.fn<(args: unknown) => void>(),
  readBinary: vi.fn<(args: unknown) => Promise<unknown>>(),
  commentsCacheGet: vi.fn<(args: unknown) => Promise<unknown>>(),
  commentsCacheSet: vi.fn<(args: unknown) => Promise<unknown>>(),
  commentsResolveTarget: vi.fn<(args: unknown) => Promise<unknown>>(),
  commentsList: vi.fn<(args: unknown) => Promise<unknown>>(),
  commentsCreate: vi.fn<(args: unknown) => Promise<unknown>>(),
  contextCreateTarget: vi.fn<(args: unknown) => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      files: {
        read: (...args: unknown[]) => mocks.read(args[0]),
        write: (...args: unknown[]) => mocks.write(args[0]),
        watch: (...args: unknown[]) => mocks.watch(args[0]),
        unwatch: (...args: unknown[]) => mocks.unwatch(args[0]),
        readBinary: (...args: unknown[]) => mocks.readBinary(args[0]),
      },
      comments: {
        cacheGet: (...args: unknown[]) => mocks.commentsCacheGet(args[0]),
        cacheSet: (...args: unknown[]) => mocks.commentsCacheSet(args[0]),
        resolveTarget: (...args: unknown[]) => mocks.commentsResolveTarget(args[0]),
        list: (...args: unknown[]) => mocks.commentsList(args[0]),
        create: (...args: unknown[]) => mocks.commentsCreate(args[0]),
        listMembers: vi.fn(async () => ({ success: true, data: { members: [] } })),
      },
      context: {
        createTarget: (...args: unknown[]) => mocks.contextCreateTarget(args[0]),
      },
      // The paintbrush header control reads/writes these (`use-paintbrush.ts`)
      // regardless of whether an agent is ever picked in this test — arming
      // the mode alone already queries them.
      settings: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => ({ success: true, data: undefined })),
      },
    },
    agents: {
      list: vi.fn(async () => []),
      listMetadata: vi.fn(async () => []),
    },
    app: {
      openPath: vi.fn(async () => ({ success: true, data: undefined })),
      showItemInFolder: vi.fn(async () => ({ success: true, data: undefined })),
    },
  },
  events: {
    on: vi.fn(() => () => {}),
  },
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function resolveOnMacrotask<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 20));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error('waitFor timed out');
}

function loadingGone(host: HTMLDivElement): boolean {
  return !host.textContent?.includes('Loading…');
}

describe('paintbrush mode toggle — zero layout shift on the document container', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient();
    resetPreviewModeMemoryForTests();
    mocks.read.mockReset();
    mocks.write.mockReset().mockResolvedValue({ success: true, data: undefined });
    mocks.watch.mockReset();
    mocks.unwatch.mockReset();
    mocks.readBinary.mockReset();
    mocks.commentsCacheGet.mockReset().mockResolvedValue(null);
    mocks.commentsCacheSet.mockReset().mockResolvedValue({ success: true, data: undefined });
    mocks.commentsResolveTarget.mockReset().mockResolvedValue({
      success: false,
      error: { kind: 'notBound', message: 'Not bound' },
    });
    mocks.commentsList.mockReset().mockResolvedValue({ success: true, data: { messages: [] } });
    mocks.commentsCreate.mockReset();
    mocks.contextCreateTarget.mockReset().mockResolvedValue({
      success: true,
      data: { targetRef: 'test-target' },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderArtifact(path: string): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ArtifactView root="/repo" rootId="repo-1" path={path} onNavigateFolder={() => {}} />
        </QueryClientProvider>
      );
    });
  }

  /** The shared scroll container both the document and the margin rail live in — `artifact-view.tsx`'s `containerRef`. */
  function findContainer(): HTMLElement {
    const el = host.querySelector('.relative.min-h-0.flex-1.overflow-y-auto');
    expect(el).toBeTruthy();
    return el as HTMLElement;
  }

  it('toggling paintbrush on and off changes no inline style, no computed box model, and no children of the document container', async () => {
    mocks.read.mockImplementation(() =>
      resolveOnMacrotask({
        success: true,
        data: { content: '# Notes\n\nSome body text for the container.\n', truncated: false },
      })
    );

    await renderArtifact('/repo/notes.md');
    await waitFor(() => loadingGone(host));

    const container = findContainer();
    // Every visual cue this container ever wears is class-driven (a
    // Tailwind `ring`, which compiles to `box-shadow` — never a layout-
    // affecting property) — there must be no inline style at all, at rest.
    expect(container.getAttribute('style')).toBeNull();

    const restingChildTags = Array.from(container.children).map((child) => child.tagName);
    const restingComputed = getComputedStyle(container);
    const restingBox = {
      padding: restingComputed.padding,
      border: restingComputed.borderWidth,
      outline: restingComputed.outlineWidth,
      width: restingComputed.width,
    };

    // The toggle is the one `aria-pressed` button in the header; found by
    // state, not by its label, so copy changes can't break a layout test.
    const findToggle = (pressed: 'true' | 'false') =>
      Array.from(host.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-pressed') === pressed
      );

    const armButton = findToggle('false');
    expect(armButton).toBeTruthy();
    await act(async () => {
      armButton!.click();
    });

    // Armed: still no inline style anywhere on the container, no new
    // direct child inserted into the scroll area (the cursor chip and the
    // coach-mark popover both portal to `document.body` — see their own
    // files), and no change to the computed box model.
    expect(container.getAttribute('style')).toBeNull();
    expect(Array.from(container.children).map((child) => child.tagName)).toEqual(
      restingChildTags
    );
    const armedComputed = getComputedStyle(container);
    expect({
      padding: armedComputed.padding,
      border: armedComputed.borderWidth,
      outline: armedComputed.outlineWidth,
      width: armedComputed.width,
    }).toEqual(restingBox);
    // The coach mark's own popover (a portal, per `popover.tsx`) must not
    // have landed inside the scroll container either.
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const disarmButton = findToggle('true');
    expect(disarmButton).toBeTruthy();
    await act(async () => {
      disarmButton!.click();
    });

    expect(container.getAttribute('style')).toBeNull();
    expect(Array.from(container.children).map((child) => child.tagName)).toEqual(
      restingChildTags
    );
  });
});
