import { app, clipboard, dialog, Menu, shell } from 'electron';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { PRODUCT_NAME } from '@shared/app-identity';
import {
  menuCheckForUpdatesChannel,
  menuCloseTabChannel,
  menuGiveFeedbackChannel,
  menuOpenSettingsChannel,
  menuRedoChannel,
  menuUndoChannel,
  nativeMenuCommandStateChannel,
  type NativeMenuCommandState,
} from '@shared/events/appEvents';
import { RIG_ISSUES_NEW_URL, RIG_RELEASES_URL, RIG_WEBSITE_URL } from '@shared/urls';
import {
  deriveNativeMenuItemChanges,
  DISABLED_NATIVE_MENU_STATE,
  NATIVE_MENU_ITEM_IDS,
} from './native-menu-state';
import { getMainWindow } from './window';

let stopMenuStateListener: (() => void) | null = null;
let quitPromptOpen = false;

function copyInstallationId(): void {
  const instanceId = telemetryService.getInstanceId() ?? 'unavailable';
  const lines = [
    `${PRODUCT_NAME} ${app.getVersion()}`,
    `Installation ID: ${instanceId}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron}`,
  ];
  clipboard.writeText(lines.join('\n'));
}

async function requestQuit(): Promise<void> {
  const win = getMainWindow();
  if (!win || win.webContents.isLoading()) {
    app.quit();
    return;
  }

  if (quitPromptOpen) return;
  quitPromptOpen = true;

  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: `Quit ${PRODUCT_NAME}?`,
      message: `Quit ${PRODUCT_NAME}?`,
      detail: 'Active terminal sessions and running agents will stop.',
      buttons: ['Cancel', `Quit ${PRODUCT_NAME}`],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) app.quit();
  } catch (error) {
    // Cmd-Q must never become a dead action because the confirmation UI
    // failed. The user explicitly requested quit, so fall back to the same
    // bounded shutdown path `rpc.app.quit()` uses.
    log.error('Failed to show quit confirmation', error);
    app.quit();
  } finally {
    quitPromptOpen = false;
  }
}

function applyNativeMenuState(menu: Menu, state: NativeMenuCommandState): void {
  for (const change of deriveNativeMenuItemChanges(state)) {
    const item = menu.getMenuItemById(change.id);
    if (!item) continue;
    item.enabled = change.enabled;
    if (change.label) item.label = change.label;
  }
}

export function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: `About ${app.name}`,
                click: () => app.showAboutPanel(),
              },
              { type: 'separator' as const },
              {
                id: NATIVE_MENU_ITEM_IDS.settings,
                label: 'Settings\u2026',
                accelerator: 'CmdOrCtrl+,',
                enabled: false,
                click: () => events.emit(menuOpenSettingsChannel, undefined),
              },
              {
                id: NATIVE_MENU_ITEM_IDS.update,
                label: 'Check for Updates\u2026',
                enabled: false,
                click: () => events.emit(menuCheckForUpdatesChannel, undefined),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              {
                label: `Quit ${app.name}`,
                accelerator: 'CmdOrCtrl+Q',
                click: () => void requestQuit(),
              },
            ],
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    // File menu
    {
      label: 'File',
      submenu: [
        // On non-macOS, put Settings in File menu
        ...(!isMac
          ? [
              {
                id: NATIVE_MENU_ITEM_IDS.settings,
                label: 'Settings\u2026',
                accelerator: 'CmdOrCtrl+,',
                enabled: false,
                click: () => events.emit(menuOpenSettingsChannel, undefined),
              },
              { type: 'separator' as const },
            ]
          : []),
        // macOS-only: Electron auto-populates this from `app.addRecentDocument`
        // calls (`rig/workspace.ts`'s `detect`, on every successful rig open).
        ...(isMac
          ? [
              {
                role: 'recentDocuments' as const,
                submenu: [{ role: 'clearRecentDocuments' as const }],
              },
              { type: 'separator' as const },
            ]
          : []),
        isMac
          ? {
              id: NATIVE_MENU_ITEM_IDS.closeTab,
              label: 'Close Tab',
              accelerator: 'CmdOrCtrl+W',
              enabled: false,
              click: () => events.emit(menuCloseTabChannel, undefined),
            }
          : {
              label: 'Quit',
              accelerator: 'CmdOrCtrl+Q',
              click: () => void requestQuit(),
            },
      ],
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        {
          id: NATIVE_MENU_ITEM_IDS.undo,
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          enabled: false,
          click: () => events.emit(menuUndoChannel, undefined),
        },
        {
          id: NATIVE_MENU_ITEM_IDS.redo,
          label: 'Redo',
          accelerator: isMac ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y',
          enabled: false,
          click: () => events.emit(menuRedoChannel, undefined),
        },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' as const },
        { role: 'selectAll' as const },
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    // Window menu
    { role: 'windowMenu' as const },
    // Help menu
    {
      role: 'help' as const,
      label: 'Help',
      submenu: [
        ...(!isMac
          ? [
              {
                id: NATIVE_MENU_ITEM_IDS.update,
                label: 'Check for Updates\u2026',
                enabled: false,
                click: () => events.emit(menuCheckForUpdatesChannel, undefined),
              },
              { type: 'separator' as const },
            ]
          : []),
        {
          label: 'Docs',
          click: () => {
            void shell.openExternal(RIG_WEBSITE_URL);
          },
        },
        {
          label: 'Changelog',
          click: () => {
            void shell.openExternal(RIG_RELEASES_URL);
          },
        },
        { type: 'separator' as const },
        {
          label: 'Troubleshooting',
          submenu: [
            {
              label: 'Report Issue\u2026',
              click: () => {
                void shell.openExternal(RIG_ISSUES_NEW_URL);
              },
            },
            {
              label: 'Copy Installation ID',
              click: copyInstallationId,
            },
          ],
        },
        {
          id: NATIVE_MENU_ITEM_IDS.feedback,
          label: 'Give Feedback',
          enabled: false,
          click: () => events.emit(menuGiveFeedbackChannel, undefined),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  applyNativeMenuState(menu, DISABLED_NATIVE_MENU_STATE);
  Menu.setApplicationMenu(menu);
  stopMenuStateListener?.();
  stopMenuStateListener = events.on(nativeMenuCommandStateChannel, (state) => {
    applyNativeMenuState(menu, state);
  });
}
