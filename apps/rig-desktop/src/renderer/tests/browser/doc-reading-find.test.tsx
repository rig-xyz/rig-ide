import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactView } from '@renderer/features/artifact/artifact-view';
import { resetPreviewModeMemoryForTests } from '@renderer/features/artifact/preview-mode-memory';
import { rigFileChangeChannel } from '@shared/rig/files';

/**
 * Find in a doc's reading view: Cmd-F opens a bar over the rendered doc,
 * matches are painted with the CSS Custom Highlight API and stepped through
 * with a count, they follow the doc as it changes, and switching to the
 * editor carries the query into CodeMirror's own find.
 */

const mocks = vi.hoisted(() => ({
  read: vi.fn<(args: unknown) => Promise<unknown>>(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      files: {
        read: (...args: unknown[]) => mocks.read(args[0]),
        write: vi.fn(async () => ({ success: true, data: undefined })),
        watch: vi.fn(),
        unwatch: vi.fn(),
        readBinary: vi.fn(),
      },
      comments: {
        cacheGet: vi.fn(async () => null),
        cacheSet: vi.fn(async () => ({ success: true, data: undefined })),
        resolveTarget: vi.fn(async () => ({ success: false, error: { kind: 'notBound', message: 'Not bound' } })),
        list: vi.fn(async () => ({ success: true, data: { messages: [] } })),
        create: vi.fn(),
        listMembers: vi.fn(async () => ({ success: true, data: { members: [] } })),
      },
      context: { createTarget: vi.fn(async () => ({ success: true, data: { targetRef: 't' } })) },
      settings: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({ success: true, data: undefined })) },
    },
    agents: { list: vi.fn(async () => []), listMetadata: vi.fn(async () => []) },
    app: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  },
  events: {
    on: vi.fn((channel: { name?: string } | string, listener: (payload: unknown) => void) => {
      mocks.listeners.set(typeof channel === 'string' ? channel : JSON.stringify(channel), listener);
      return () => {};
    }),
  },
}));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
  throw new Error('waitFor timed out');
}

function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const DOC = '# Pricing\n\nOur pricing tiers.\n\nMore pricing below.\n';

describe('Find in a doc’s reading view', () => {
  let host: HTMLDivElement;
  let root: Root;

  const bar = () => host.querySelector<HTMLElement>('[data-testid="reading-find"]');
  const input = () => host.querySelector<HTMLInputElement>('[data-testid="reading-find-input"]')!;
  const count = () => host.querySelector('[data-testid="reading-find-count"]')?.textContent ?? null;
  const painted = () => CSS.highlights.get('rig-doc-find')?.size ?? 0;
  const current = () => [...(CSS.highlights.get('rig-doc-find-current') ?? [])][0] as Range | undefined;
  const button = (label: string) =>
    Array.from(bar()?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === label || b.getAttribute('aria-label') === label
    )!;

  beforeEach(async () => {
    host = document.createElement('div');
    host.style.cssText = 'width: 900px; height: 600px; display: flex; flex-direction: column;';
    document.body.appendChild(host);
    root = createRoot(host);
    resetPreviewModeMemoryForTests();
    mocks.listeners.clear();
    mocks.read.mockReset().mockResolvedValue({ success: true, data: { content: DOC, truncated: false } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ArtifactView root="/repo" rootId="repo-1" path="/repo/notes.md" onNavigateFolder={() => {}} />
        </QueryClientProvider>
      );
    });
    await waitFor(() => host.textContent?.includes('Our pricing tiers') ?? false);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('opens on Cmd-F, counts and paints the matches, and steps through them', async () => {
    await act(async () => void key(document.body, { key: 'f', metaKey: true }));
    expect(bar()).not.toBeNull();
    expect(document.activeElement).toBe(input());

    await type(input(), 'pricing');
    expect(count()).toBe('1 of 3');
    expect(painted()).toBe(3);
    expect(current()?.toString()).toBe('Pricing');

    await act(async () => void key(input(), { key: 'Enter' }));
    expect(count()).toBe('2 of 3');
    expect(current()?.toString()).toBe('pricing');
    await act(async () => void key(input(), { key: 'Enter', shiftKey: true }));
    expect(count()).toBe('1 of 3');
    // Cmd-G and Shift-Cmd-G from the doc as well as the field.
    await act(async () => void key(document.body, { key: 'g', metaKey: true }));
    await act(async () => void key(document.body, { key: 'g', metaKey: true }));
    expect(count()).toBe('3 of 3');
    await act(async () => void key(document.body, { key: 'g', metaKey: true, shiftKey: true }));
    expect(count()).toBe('2 of 3');
    await act(async () => button('Next').click());
    expect(count()).toBe('3 of 3');
    await act(async () => button('Previous').click());
    expect(count()).toBe('2 of 3');
  });

  it('matches case when asked, and says when nothing matches', async () => {
    await act(async () => void key(document.body, { key: 'f', metaKey: true }));
    await type(input(), 'Pricing');
    expect(count()).toBe('1 of 3');
    const matchCase = bar()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => matchCase.click());
    expect(count()).toBe('1 of 1');
    expect(painted()).toBe(1);
    await type(input(), 'zeppelin');
    expect(count()).toBe('No matches');
    expect(painted()).toBe(0);
  });

  it('follows the doc as it changes on disk', async () => {
    await act(async () => void key(document.body, { key: 'f', metaKey: true }));
    await type(input(), 'pricing');
    expect(count()).toBe('1 of 3');

    mocks.read.mockResolvedValue({
      success: true,
      data: { content: `${DOC}\nPricing again, and pricing once more.\n`, truncated: false },
    });
    const onChange = mocks.listeners.get(JSON.stringify(rigFileChangeChannel));
    expect(onChange).toBeTruthy();
    await act(async () => onChange!({ rootId: 'repo-1', paths: ['notes.md'] }));
    await waitFor(() => count() === '1 of 5');
    expect(painted()).toBe(5);
  });

  it('closes on Esc or Close, and clears its highlights', async () => {
    await act(async () => void key(document.body, { key: 'f', metaKey: true }));
    await type(input(), 'pricing');
    await act(async () => void key(input(), { key: 'Escape' }));
    expect(bar()).toBeNull();
    expect(painted()).toBe(0);

    await act(async () => void key(document.body, { key: 'f', metaKey: true }));
    // It remembers what was typed.
    expect(input().value).toBe('pricing');
    await act(async () => button('Close').click());
    expect(bar()).toBeNull();
  });

  it('scrolls the current match into view', async () => {
    // The test page loads no Tailwind: give the pane its column and the doc its scroller.
    const style = document.createElement('style');
    style.textContent = `
      :has(> [data-testid="reading-find"]) { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; }
      [data-testid="reading-find"] + div { overflow-y: auto; flex: 1 1 0; min-height: 0; }
    `;
    document.head.appendChild(style);
    try {
      const filler = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} about nothing.`).join('\n\n');
      mocks.read.mockResolvedValue({ success: true, data: { content: `${DOC}\n${filler}\n\nThe zeppelin.\n`, truncated: false } });
      const onChange = mocks.listeners.get(JSON.stringify(rigFileChangeChannel))!;
      await act(async () => onChange({ rootId: 'repo-1', paths: ['notes.md'] }));
      await waitFor(() => host.textContent?.includes('The zeppelin') ?? false);

      await act(async () => void key(document.body, { key: 'f', metaKey: true }));
      const scroller = bar()!.nextElementSibling as HTMLElement;
      expect(scroller.scrollTop).toBe(0);
      await type(input(), 'zeppelin');
      await waitFor(() => scroller.scrollTop > 0);
      const match = current()!.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      expect(match.top).toBeGreaterThanOrEqual(box.top);
      expect(match.bottom).toBeLessThanOrEqual(box.bottom);
    } finally {
      style.remove();
    }
  });

  it('carries the query into the editor’s find when switching to Edit, and back', async () => {
    await act(async () => void key(document.body, { key: 'f', metaKey: true }));
    await type(input(), 'tiers');
    const edit = host.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!;
    await act(async () => edit.click());
    await waitFor(() => host.querySelector('.cm-editor') !== null);
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(getSearchQuery(view.state).search).toBe('tiers');
    expect(bar()).toBeNull();

    const preview = host.querySelector<HTMLButtonElement>('button[aria-label="Preview"]')!;
    await act(async () => preview.click());
    await waitFor(() => bar() !== null);
    expect(input().value).toBe('tiers');
    expect(count()).toBe('1 of 1');
  });
});
