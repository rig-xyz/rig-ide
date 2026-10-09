import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactView } from '@renderer/features/artifact/artifact-view';
import { onFileMove, type FileMove } from '@renderer/features/workspace/file-moves';
import { onOpenFileRequest } from '@renderer/features/workspace/open-file-request';

/**
 * The `⋯` beside a file's name in its title bar (`file-options-menu.tsx`):
 * it opens the shared file actions for the open file, and Rename and
 * Archive save unsaved edits first, then announce the move so `App.tsx`
 * moves or closes the tab.
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
  saveToDownloads: vi.fn<(path: string) => Promise<unknown>>(),
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));

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
      // A toml file takes comments: the store settles as not in a space.
      comments: {
        cacheGet: vi.fn(async () => null),
        cacheSet: vi.fn(async () => ({ success: true, data: undefined })),
        resolveTarget: vi.fn(async () => ({ success: false, error: { kind: 'notBound', message: 'Not bound' } })),
        list: vi.fn(async () => ({ success: false, error: { kind: 'notBound', message: 'Not bound' } })),
      },
    },
    agents: {
      list: vi.fn(async () => []),
      listMetadata: vi.fn(async () => []),
    },
    app: {
      clipboardWriteText: (...args: unknown[]) => mocks.clipboardWriteText(args[0] as string),
      showItemInFolder: (...args: unknown[]) => mocks.showItemInFolder(args[0] as string),
      saveToDownloads: (...args: unknown[]) => mocks.saveToDownloads(args[0] as string),
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
  let moves: FileMove[] = [];
  let stopListening: () => void = () => {};

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
    mocks.saveToDownloads.mockReset().mockResolvedValue({ success: true, path: '/Users/me/Downloads/config 2.toml' });
    mocks.toast.mockReset();
    moves = [];
    stopListening = onFileMove((move) => moves.push(move));
  });

  afterEach(async () => {
    stopListening();
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(path: string, root_ = '/repo') {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ArtifactView
            root={root_}
            rootId="repo-1"
            bindingId="binding-1"
            path={path}
            onNavigateFolder={() => {}}
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
    expect(labels).toEqual(['Pin to top', 'Copy path', 'Reveal in Finder', 'Save to Downloads', 'Rename', 'Archive']);
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

  it('Save to Downloads copies the file there, then says so with Show in Finder', async () => {
    await render('/repo/notes/config.toml');
    await openMenu();
    await act(async () => click(item('Save to Downloads')));
    await waitFor(() => mocks.toast.mock.calls.length > 0);
    expect(mocks.saveToDownloads).toHaveBeenCalledWith('/repo/notes/config.toml');
    const shown = mocks.toast.mock.calls[0]![0] as { title: string; action: { label: string; onClick: () => void } };
    expect(shown.title).toBe('Saved to Downloads');
    expect(shown.action.label).toBe('Show in Finder');
    shown.action.onClick();
    expect(mocks.showItemInFolder).toHaveBeenCalledWith('/Users/me/Downloads/config 2.toml');
  });

  it('Save to Downloads says when the copy failed', async () => {
    mocks.saveToDownloads.mockResolvedValue({ success: false, error: 'No space left.' });
    await render('/repo/notes/config.toml');
    await openMenu();
    await act(async () => click(item('Save to Downloads')));
    await waitFor(() => mocks.toast.mock.calls.length > 0);
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't save to Downloads", description: 'No space left.' }));
  });

  it('Rename opens the rename dialog, and saving announces the new path for the tab to follow', async () => {
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
    await waitFor(() => moves.length > 0);

    expect(mocks.rename).toHaveBeenCalledWith({
      rootId: 'repo-1',
      relativePath: 'notes/config.toml',
      newName: 'renamed.toml',
    });
    expect(moves).toEqual([{ from: '/repo/notes/config.toml', to: '/repo/notes/renamed.toml' }]);
  });

  it('Archive moves the file and announces it is gone', async () => {
    await render('/repo/notes/config.toml');
    await openMenu();
    await act(async () => click(item('Archive')));
    await waitFor(() => moves.length > 0);
    expect(mocks.archive).toHaveBeenCalledWith({
      rootId: 'repo-1',
      relativePath: 'notes/config.toml',
    });
    expect(moves).toEqual([{ from: '/repo/notes/config.toml', to: null }]);
  });

  it('saves an unsaved edit at the old path before archiving', async () => {
    await render('/repo/notes/config.toml');
    await waitFor(
      () => host.querySelector('.cm-editor') !== null && !host.textContent?.includes('Loading…')
    );
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!;
    await act(async () => {
      view.dispatch({ changes: { from: 0, insert: 'edited = 2\n' } });
    });
    await openMenu();
    await act(async () => click(item('Archive')));
    await waitFor(() => moves.length > 0);

    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'notes/config.toml',
        content: 'edited = 2\nkey = 1\n',
      })
    );
    expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.archive.mock.invocationCallOrder[0]
    );
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

  it('stays hidden for a file outside the rig', async () => {
    await render('/repo/notes/config.toml', '/elsewhere');
    await waitFor(() => host.querySelector('.cm-content') !== null);
    expect(trigger()).toBeNull();
  });

  describe('a version of yours that lost a clash', () => {
    const banner = () => host.querySelector<HTMLElement>('[data-testid="conflict-copy-banner"]');
    const bannerButton = (label: string) =>
      Array.from(banner()?.querySelectorAll('button') ?? []).find((b) => b.textContent === label)!;

    it('says what it is above the doc, and opens the file it came from', async () => {
      const opened: string[] = [];
      const stop = onOpenFileRequest((path) => opened.push(path));
      try {
        await render('/repo/notes/config.conflict-from.mac.chg_4.toml');
        await waitFor(() => banner() !== null);
        expect(banner()!.textContent).toContain(
          'This is a version of yours that didn’t make it into config.toml. Copy what you need into it, then archive this one.'
        );
        await act(async () => click(bannerButton('Open config.toml')));
        expect(opened).toEqual(['/repo/notes/config.toml']);
      } finally {
        stop();
      }
    });

    it('archives itself', async () => {
      await render('/repo/notes/config.conflict-from.mac.chg_4.toml');
      await waitFor(() => banner() !== null);
      await act(async () => click(bannerButton('Archive this version')));
      await waitFor(() => moves.length > 0);
      expect(mocks.archive).toHaveBeenCalledWith({
        rootId: 'repo-1',
        relativePath: 'notes/config.conflict-from.mac.chg_4.toml',
      });
      expect(moves).toEqual([{ from: '/repo/notes/config.conflict-from.mac.chg_4.toml', to: null }]);
    });

    it('is not there for any other file', async () => {
      await render('/repo/notes/config.toml');
      await waitFor(() => host.querySelector('.cm-content') !== null);
      expect(banner()).toBeNull();
    });
  });
});
