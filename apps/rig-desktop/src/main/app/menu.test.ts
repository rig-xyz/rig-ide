import { beforeEach, describe, expect, it, vi } from 'vitest';
import { menuCloseTabChannel, nativeMenuCommandStateChannel } from '@shared/events/appEvents';
import { NATIVE_MENU_ITEM_IDS } from './native-menu-state';

const mocks = vi.hoisted(() => {
  const items = new Map<string, Electron.MenuItemConstructorOptions>();
  return {
    items,
    template: null as Electron.MenuItemConstructorOptions[] | null,
    menuStateListener: null as ((state: unknown) => void) | null,
    emit: vi.fn(),
    quit: vi.fn(),
    showMessageBox: vi.fn(),
    win: {
      webContents: { isLoading: vi.fn(() => false) },
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  app: {
    name: 'Rig',
    getVersion: () => '1.0.0',
    showAboutPanel: vi.fn(),
    quit: mocks.quit,
  },
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: vi.fn() },
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      mocks.template = template;
      mocks.items.clear();
      const visit = (entries: Electron.MenuItemConstructorOptions[]) => {
        for (const entry of entries) {
          if (entry.id) mocks.items.set(entry.id, entry);
          if (Array.isArray(entry.submenu)) visit(entry.submenu);
        }
      };
      visit(template);
      return { getMenuItemById: (id: string) => mocks.items.get(id) ?? null };
    },
    setApplicationMenu: vi.fn(),
  },
}));

vi.mock('@main/lib/events', () => ({
  events: {
    emit: mocks.emit,
    on: (event: { name: string }, cb: (state: unknown) => void) => {
      if (event.name === nativeMenuCommandStateChannel.name) mocks.menuStateListener = cb;
      return () => {
        mocks.menuStateListener = null;
      };
    },
  },
}));

vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('@main/lib/telemetry', () => ({
  telemetryService: { getInstanceId: () => 'test-installation' },
}));
vi.mock('./window', () => ({ getMainWindow: () => mocks.win }));

import { setupApplicationMenu } from './menu';

function findItem(label: string): Electron.MenuItemConstructorOptions | undefined {
  const visit = (
    entries: Electron.MenuItemConstructorOptions[]
  ): Electron.MenuItemConstructorOptions | undefined => {
    for (const entry of entries) {
      if (entry.label === label) return entry;
      if (Array.isArray(entry.submenu)) {
        const nested = visit(entry.submenu);
        if (nested) return nested;
      }
    }
    return undefined;
  };
  return mocks.template ? visit(mocks.template) : undefined;
}

describe('native application menu', () => {
  beforeEach(() => {
    mocks.emit.mockReset();
    mocks.quit.mockReset();
    mocks.showMessageBox.mockReset();
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    setupApplicationMenu();
  });

  it('declares native Mac close and quit accelerators', () => {
    if (process.platform !== 'darwin') return;
    expect(findItem('Close Tab')).toMatchObject({ accelerator: 'CmdOrCtrl+W' });
    expect(findItem('Quit Rig')).toMatchObject({ accelerator: 'CmdOrCtrl+Q' });
  });

  it('routes Close Tab through the typed renderer command', () => {
    if (process.platform !== 'darwin') return;
    mocks.items.get(NATIVE_MENU_ITEM_IDS.closeTab)?.click?.({} as never, {} as never, {} as never);
    expect(mocks.emit).toHaveBeenCalledWith(menuCloseTabChannel, undefined);
  });

  it('applies renderer availability and update labels', () => {
    mocks.menuStateListener?.({
      settings: true,
      closeTab: true,
      undo: false,
      redo: false,
      update: 'restart',
      feedback: true,
    });

    expect(mocks.items.get(NATIVE_MENU_ITEM_IDS.closeTab)?.enabled).toBe(true);
    expect(mocks.items.get(NATIVE_MENU_ITEM_IDS.update)).toMatchObject({
      enabled: true,
      label: 'Restart to Update',
    });
  });

  it('confirms Cmd-Q and enters the normal quit path on approval', async () => {
    if (process.platform !== 'darwin') return;
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    findItem('Quit Rig')?.click?.({} as never, {} as never, {} as never);
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
  });
});
