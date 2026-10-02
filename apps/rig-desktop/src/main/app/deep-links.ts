import { resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { log } from '@main/lib/logger';
import { deepLinkInbox } from '@main/rig/deep-link';
import { openSpaceInbox } from '@main/rig/notifications/electron';
import {
  findRigUrlInArgv,
  parseRigDeepLink,
  RIG_URL_SCHEME,
  toJoinRequest,
} from '@shared/rig/deep-link';
import { createMainWindow, getMainWindow } from './window';

/**
 * OS plumbing for `rig://` deep links (`@shared/rig/deep-link.ts` has the
 * contract). Three ways a link arrives:
 *   - macOS: `open-url`, which can fire before `app.whenReady()` on a cold
 *     launch, so `installDeepLinkHandlers` must run at module load;
 *   - Windows/Linux, app already running: the second instance's argv, via
 *     the existing single-instance lock's `second-instance` event
 *     (`handleDeepLinkArgv`, called from `main/index.ts`);
 *   - Windows/Linux, cold launch: this process's own `process.argv`.
 * Every link goes through `deepLinkInbox`, which holds it until the
 * renderer's confirm dialog is mounted. Nothing here joins anything.
 *
 * macOS routes `rig://` by the bundle's Info.plist (`protocols` in
 * `electron-builder.config.ts`), so only a packaged app receives links
 * there; on Windows/Linux `pnpm dev` registers the Electron binary + app
 * path instead.
 *
 * The scheme is per channel (`RIG_URL_SCHEME`, from `URL_SCHEME` in
 * `@shared/app-identity`): stable and dev register and accept `rig://`,
 * canary `rig-canary://` (declared in `electron-builder.canary.config.ts`),
 * so an installed canary never takes the website's `rig://` links away from
 * stable.
 */

/** Set once startup has opened its first window; before that, startup itself is about to. */
let windowEverCreated = false;

export function installDeepLinkHandlers(): void {
  registerProtocolClient();

  app.on('browser-window-created', () => {
    windowEverCreated = true;
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    receiveDeepLink(url);
  });

  const fromArgv = findRigUrlInArgv(process.argv);
  if (fromArgv) receiveDeepLink(fromArgv);
}

/** `second-instance` (Windows/Linux): the link, if any, rides in the new instance's argv. */
export function handleDeepLinkArgv(argv: readonly string[]): void {
  const url = findRigUrlInArgv(argv);
  if (url) receiveDeepLink(url);
}

function registerProtocolClient(): void {
  // macOS dev: skipped. There the call registers the bare Electron.app
  // bundle (it ignores the path/args below), which doesn't declare the scheme and
  // can't route a link back to this app, so all it would do is take the
  // default away from an installed Rig.app until that next launches.
  if (process.defaultApp && process.platform === 'darwin') return;
  // Electron's documented dev form: an unpackaged run is `electron <script>`,
  // so the OS must relaunch the Electron binary WITH the app path.
  const registered = process.defaultApp
    ? process.argv[1]
      ? app.setAsDefaultProtocolClient(RIG_URL_SCHEME, process.execPath, [resolve(process.argv[1])])
      : false
    : app.setAsDefaultProtocolClient(RIG_URL_SCHEME);
  if (!registered) log.warn(`deep links: could not register as the ${RIG_URL_SCHEME}:// handler`);
}

function receiveDeepLink(url: string): void {
  const link = parseRigDeepLink(url);
  if (!link) {
    // Never the URL itself: a near-miss can still carry an invite secret.
    log.info('ignored deep link');
    return;
  }
  if (link.kind === 'space') {
    const outcome = openSpaceInbox.push({ bindingId: link.bindingId, messageId: link.messageId });
    log.info('deep link: open space received', { outcome });
    focusMainWindow();
    return;
  }
  const outcome = deepLinkInbox.push(toJoinRequest(link));
  log.info('deep link: join request received', { outcome });
  focusMainWindow();
}

function focusMainWindow(): void {
  const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) {
    // Cold launch: startup is about to open the window. Otherwise it's
    // macOS running with every window closed: open one, and its renderer
    // drains the inbox once it mounts.
    if (app.isReady() && windowEverCreated) createMainWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
