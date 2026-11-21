import type { App } from 'electron';

/**
 * "Open Rig when you log in" (Settings › General, on by default). Work on a schedule in a space
 * runs in the Rig app of the member it names, so it only runs while Rig is running: without this
 * a restart of the computer stops every schedule until someone thinks of opening Rig.
 *
 * Opened by the login, Rig starts with no window: it is there for its schedules, and the window
 * comes when the person asks for it (the Dock, a notification, a link).
 */

type LoginApp = Pick<
  App,
  'isPackaged' | 'setLoginItemSettings' | 'getLoginItemSettings' | 'isInApplicationsFolder'
>;

/** Given to Rig when the login opens it, where the system has no other way to say so (Windows). */
export const OPENED_AT_LOGIN_ARG = '--opened-at-login';

const supported = (platform: NodeJS.Platform) => platform === 'darwin' || platform === 'win32';

/**
 * Tells the system whether to open Rig at login. Only for the installed app: a development run
 * would put the bare Electron binary in the person's login items, and a copy run from a disk
 * image or a build folder would register that path, which is gone or stale by the next login.
 * Returns whether it was told.
 */
export function applyOpenAtLogin(app: LoginApp, platform: NodeJS.Platform, enabled: boolean): boolean {
  if (!app.isPackaged || !supported(platform)) return false;
  // The system can refuse (a managed Mac, a login item the person removed by hand). Rig then
  // simply does not open at login: this runs while the app starts, and must never stop it.
  try {
    if (platform === 'darwin' && !app.isInApplicationsFolder()) return false;
    app.setLoginItemSettings({
      openAtLogin: enabled,
      ...(platform === 'win32' ? { args: [OPENED_AT_LOGIN_ARG] } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether this run was started by the login and not by the person: then no window is opened for it. */
export function openedAtLogin(app: LoginApp, platform: NodeJS.Platform, argv: readonly string[]): boolean {
  if (!app.isPackaged) return false;
  if (platform === 'win32') return argv.includes(OPENED_AT_LOGIN_ARG);
  if (platform !== 'darwin') return false;
  // Not knowing means the person gets their window, as before.
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}
