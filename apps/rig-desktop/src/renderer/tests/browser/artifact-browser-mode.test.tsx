import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { ArtifactView } from '@renderer/features/artifact/artifact-view';
import { resetPreviewModeMemoryForTests } from '@renderer/features/artifact/preview-mode-memory';
import { requestBrowserMode, requestView, resetViewRequestsForTests, useViewRequest } from '@renderer/features/artifact/view-request';
import { resolveSpaceLink } from '@renderer/features/spaces/space-link';
import { SafeMarkdown } from '@renderer/lib/ui/comment-markdown';
import { isHtmlPath } from '@shared/spaces/rig-file';
import '@renderer/tokens.css';

/**
 * Browser mode: an html file in a space, seen as a working page next to
 * Edit. The page itself (`PageView`, a webview) is stood in for here; what
 * matters is which link it's given and what reaches it.
 */

const mocks = vi.hoisted(() => ({
  read: vi.fn<(args: unknown) => Promise<unknown>>(),
  passages: [] as string[],
}));

vi.mock('@renderer/features/pages/page-view', () => ({
  PageView: ({ url, reloadKey }: { url: string; reloadKey?: number }) => {
    useViewRequest(url, (request) => {
      if (request.passage) mocks.passages.push(request.passage);
    });
    return <div data-testid="page-view" data-url={url} data-reload={reloadKey ?? 0} />;
  },
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
      settings: { get: vi.fn(async () => ({ pinnedPathsByRig: {} })), set: vi.fn(async () => ({ success: true, data: undefined })) },
    },
    agents: { list: vi.fn(async () => []), listMetadata: vi.fn(async () => []) },
    app: {
      openPath: vi.fn(async () => ({ success: true, data: undefined })),
      showItemInFolder: vi.fn(async () => ({ success: true, data: undefined })),
      openExternal: vi.fn(async () => undefined),
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error('waitFor timed out');
}

const ROOT = '/Users/me/Rig/site';
const HTML = `${ROOT}/site/index.html`;
const PAGE = '<!doctype html>\n<h1>Pricing</h1>\n<p>Plans</p>\n<script src="app.js"></script>\n';

describe('Browser mode in the file viewer', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.width = '1000px';
    host.style.height = '700px';
    document.body.appendChild(host);
    root = createRoot(host);
    resetPreviewModeMemoryForTests();
    resetViewRequestsForTests();
    mocks.passages.length = 0;
    mocks.read.mockReset().mockResolvedValue({ success: true, data: { content: PAGE, truncated: false } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const render = async (node: ReactNode) => {
    await act(async () => {
      root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
    });
  };
  const viewer = (path: string, bindingId: string | null = 'bnd_abc') => (
    // Keyed by the file, as the app's tabs are.
    <ArtifactView key={`${path}:${bindingId}`} root={ROOT} rootId="root-1" path={path} bindingId={bindingId} onNavigateFolder={() => {}} />
  );
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const page = () => host.querySelector<HTMLElement>('[data-testid="page-view"]');
  const loaded = () => !host.textContent?.includes('Loading…') && (page() !== null || host.querySelector('.cm-content') !== null);

  it('opens an html file in Browser, from its rig-file link, with Edit one click away and no Preview', async () => {
    // Nothing asked for a mode: the file tree opens a file this way.
    await render(viewer(HTML));
    await waitFor(loaded);
    expect(page()?.dataset.url).toBe('rig-file://bnd_abc/site/index.html');
    expect(host.querySelector('.cm-content')).toBeNull();
    expect(button('Browser')).toBeTruthy();
    expect(button('Edit')).toBeTruthy();
    expect(button('Preview')).toBeNull();

    await act(async () => button('Edit')!.click());
    expect(page()).toBeNull();
    expect(host.querySelector('.cm-content')?.textContent).toContain('<h1>Pricing</h1>');

    await act(async () => button('Browser')!.click());
    expect(page()?.dataset.url).toBe('rig-file://bnd_abc/site/index.html');
  });

  it('remembers Edit for a file once chosen, for this session', async () => {
    await render(viewer(HTML));
    await waitFor(loaded);
    await act(async () => button('Edit')!.click());
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(viewer(HTML));
    await waitFor(loaded);
    expect(page()).toBeNull();
    expect(host.querySelector('.cm-content')).toBeTruthy();
  });

  it('has no Browser mode for markdown, or for html outside a space or synced rig', async () => {
    mocks.read.mockResolvedValue({ success: true, data: { content: '# Notes\n', truncated: false } });
    await render(viewer(`${ROOT}/notes.md`));
    await waitFor(() => host.querySelector('h1') !== null);
    expect(button('Browser')).toBeNull();
    expect(button('Preview')).toBeTruthy();

    mocks.read.mockResolvedValue({ success: true, data: { content: PAGE, truncated: false } });
    await render(viewer(HTML, null));
    await waitFor(loaded);
    expect(button('Browser')).toBeNull();
    expect(page()).toBeNull();
  });

  it('opens straight in Browser mode when asked before it opens, and hands the page the passage', async () => {
    requestBrowserMode(HTML, { passage: 'Plans' });
    await render(viewer(HTML));
    await waitFor(() => page() !== null && mocks.passages.length > 0);
    expect(host.querySelector('.cm-content')).toBeNull();
    expect(mocks.passages).toEqual(['Plans']);
  });

  it('switches an open file to Browser mode when asked', async () => {
    await render(viewer(HTML));
    await waitFor(loaded);
    await act(async () => button('Edit')!.click());
    expect(page()).toBeNull();
    await act(async () => requestView(HTML, { mode: 'browser' }));
    expect(page()?.dataset.url).toBe('rig-file://bnd_abc/site/index.html');
  });

  it('goes to Edit at a line when asked for one', async () => {
    requestBrowserMode(HTML);
    await render(viewer(HTML));
    await waitFor(() => page() !== null);
    await act(async () => requestView(HTML, { line: 3 }));
    await waitFor(() => host.querySelector('.cm-content') !== null);
    await waitFor(() => {
      const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement);
      return view?.state.selection.main.head === view?.state.doc.line(3).from;
    });
  });

  it('opens an html link clicked in the chat in Browser mode', async () => {
    // The Room's link handling (`room-view.tsx`): resolve against the space, an html file asks for Browser mode, then it opens.
    let opened: string | null = null;
    const onOpenPath = (href: string) => {
      const resolved = resolveSpaceLink(href, ROOT, 'bnd_abc');
      if (resolved.kind !== 'inside') return;
      const abs = `${ROOT}/${resolved.relPath}`;
      if (isHtmlPath(resolved.relPath)) requestBrowserMode(abs);
      opened = abs;
    };
    await render(
      <SafeMarkdown
        content="Here it is: [the page](rig-file://bnd_abc/site/index.html)"
        onOpenPath={onOpenPath}
        renderFileLink={({ href, children }) => (
          <a href={href} data-testid="file-link" onClick={(event) => (event.preventDefault(), onOpenPath(href))}>
            {children}
          </a>
        )}
      />
    );
    const link = host.querySelector<HTMLAnchorElement>('[data-testid="file-link"]');
    expect(link?.getAttribute('href')).toBe('rig-file://bnd_abc/site/index.html');
    await act(async () => link!.click());
    expect(opened).toBe(HTML);

    await render(viewer(opened!));
    await waitFor(() => page() !== null);
    expect(page()?.dataset.url).toBe('rig-file://bnd_abc/site/index.html');
  });
});
