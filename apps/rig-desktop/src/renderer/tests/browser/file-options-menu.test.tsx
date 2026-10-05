import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactView } from '@renderer/features/artifact/artifact-view';

/**
 * The `⋯` beside a file's name in its title bar (`file-options-menu.tsx`):
 * it opens the tree's own file actions for the open file, and Rename and
 * Archive tell the host where the file went so the view can follow.
 */

const mocks = vi.hoisted(() => ({
  read: vi.fn<(args: unknown) => Promise<unknown>>(),
  readBinary: vi.fn<(args: unknown) => Promise<unknown>>(),
  write: vi.fn<(args: unknown) => Promise<unknown>>(),
  rename: vi.fn<(args: unknown) => Promise<unknown>>(),
  archive: vi.fn<(args: unknown) => Promise<unknown>>(),
  clipboardWriteText: vi.fn<(text: string) => Promise<unknown>>(),
  showItemInFolder: vi.fn<(path: string) => Promise<unknown>>(),
  settingsSet: vi.fn<(args: unknown) => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      files: {
        read: (...args: unknown[]) => mocks.read(args[0]),
        readBinary: (...args: unknown[]) => mocks.readBinary(args[0]),
        write: (...args: unknown[]) => mocks.write(args[0]),
        rename: (...args: unknown[]) => mocks.rename(args[0]),
        archive: (...args: unknown[]) => mocks.archive(args[0]),
        watch: vi.fn(),
        unwatch: vi.fn(),
      },
      settings: {
        get: vi.fn(async () => ({ pinnedPathsByRig: {} })),
        set: (...args: unknown[]) => mocks.settingsSet(args[0]),
      },
      context: { createTarget: vi.fn(async () => ({ success: true, data: { targetRef: 't' } })) },
    },
    agents: {
      list: vi.fn(async () => []),
      listMetadata: vi.fn(async () => []),
    },
    app: {
      clipboardWriteText: (...args: unknown[]) => mocks.clipboardWriteText(args[0] as string),
      showItemInFolder: (...args: unknown[]) => mocks.showItemInFolder(args[0] as string),
      openPath: vi.fn(async () => ({ success: true, data: undefined })),
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('File options menu in the title bar', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onRenamed = vi.fn<(path: string) => void>();
  const onArchived = vi.fn<() => void>();

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.read
      .mockReset()
      .mockResolvedValue({ success: true, data: { content: 'key = 1\n', truncated: false } });
    mocks.readBinary
      .mockReset()
      .mockResolvedValue({ success: true, data: { data: btoa('png'), truncated: false, size: 3 } });
    mocks.write.mockReset().mockResolvedValue({ success: true, data: undefined });
    mocks.rename
      .mockReset()
      .mockResolvedValue({ success: true, data: { relativePath: 'notes/renamed.toml' } });
    mocks.archive
      .mockReset()
      .mockResolvedValue({ success: true, data: { relativePath: '_archive/config.toml' } });
    mocks.clipboardWriteText.mockReset().mockResolvedValue({ success: true, data: undefined });
    mocks.showItemInFolder.mockReset().mockResolvedValue({ success: true, data: undefined });
    mocks.settingsSet.mockReset().mockResolvedValue({ success: true, data: undefined });
    onRenamed.mockReset();
    onArchived.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(path: string, withHost = true) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ArtifactView
            root="/repo"
            rootId="repo-1"
            bindingId="binding-1"
            path={path}
            onNavigateFolder={() => {}}
            onRenamed={withHost ? onRenamed : undefined}
            onArchived={withHost ? onArchived : undefined}
          />
        </QueryClientProvider>
      );
    });
  }

  const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="File options"]');
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const item = (label: string) =>
    Array.from(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []).find(
      (el) => el.textContent === label
    )!;

  async function openMenu() {
    await waitFor(() => trigger() !== null);
    await act(async () => click(trigger()!));
    await waitFor(() => menu() !== null);
  }

  it("sits right after the file's name and opens the file's actions", async () => {
    await render('/repo/notes/config.toml');
    await waitFor(() => trigger() !== null);
    // Beside the title, before the header's spacer.
    expect(trigger()!.previousElementSibling?.textContent).toContain('config.toml');

    await openMenu();
    const labels = Array.from(menu()!.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.textContent
    );
    expect(labels).toEqual(['Pin to top', 'Copy path', 'Reveal in Finder', 'Rename', 'Archive']);
    expect(trigger()!.getAttribute('aria-expanded')).toBe('true');
  });

  it('Copy path writes the absolute path through the clipboard RPC and closes the menu', async () => {
    await render('/repo/notes/config.toml');
    await openMenu();
    await act(async () => click(item('Copy path')));
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('/repo/notes/config.toml');
    await waitFor(() => menu() === null);
  });

  it('Reveal in Finder calls showItemInFolder with the file', async () => {
    await render('/repo/notes/config.toml');
    await openMenu();
    await act(async () => click(item('Reveal in Finder')));
    expect(mocks.showItemInFolder).toHaveBeenCalledWith('/repo/notes/config.toml');
  });

  it('Rename opens the rename dialog, and saving hands the host the new path', async () => {
    await render('/repo/notes/config.toml');
    await openMenu();
    await act(async () => click(item('Rename')));
    await waitFor(() => document.querySelector('#rig-file-rename') !== null);
    const input = document.querySelector<HTMLInputElement>('#rig-file-rename')!;
    expect(input.value).toBe('config.toml');

    // React tracks the input's value itself; go through the native setter.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'renamed.toml');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save'
    )!;
    await act(async () => click(save));
    await waitFor(() => onRenamed.mock.calls.length > 0);

    expect(mocks.rename).toHaveBeenCalledWith({
      rootId: 'repo-1',
      relativePath: 'notes/config.toml',
      newName: 'renamed.toml',
    });
    expect(onRenamed).toHaveBeenCalledWith('/repo/notes/renamed.toml');
  });

  it('Archive moves the file and tells the host it is gone', async () => {
    await render('/repo/notes/config.toml');
    await openMenu();
    await act(async () => click(item('Archive')));
    await waitFor(() => onArchived.mock.calls.length > 0);
    expect(mocks.archive).toHaveBeenCalledWith({
      rootId: 'repo-1',
      relativePath: 'notes/config.toml',
    });
  });

  it('Pin to top pins the file for this rig', async () => {
    await render('/repo/notes/config.toml');
    await openMenu();
    await act(async () => click(item('Pin to top')));
    expect(mocks.settingsSet).toHaveBeenCalledWith({
      pinnedPathsByRig: { 'binding-1': ['notes/config.toml'] },
    });
  });

  it('shows for files without Share too, like images', async () => {
    await render('/repo/photo.png');
    await waitFor(() => trigger() !== null);
    expect(host.querySelector('button[aria-label="Share file"]')).toBeNull();
  });

  it('stays hidden when the host cannot follow a rename or archive', async () => {
    await render('/repo/notes/config.toml', false);
    await waitFor(() => host.querySelector('.cm-content') !== null);
    expect(trigger()).toBeNull();
  });
});
