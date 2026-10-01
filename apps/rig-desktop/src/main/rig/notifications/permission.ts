import { shell } from 'electron';
import type { MacNotificationPermission } from '@shared/rig/notifications';

/**
 * This app's macOS notification permission (`@rigxyz/mac-notifications`, a
 * small native addon over UNUserNotificationCenter). Electron's own
 * `Notification` neither reports it nor reliably asks for it, so a banner
 * shown before permission was ever requested can silently never appear:
 * the Activity panel asks at the first moment it matters, and Settings
 * shows where things stand.
 *
 * Off macOS everything here is 'unsupported' and a no-op. The addon is
 * loaded lazily so plain-Node tests never touch it.
 */

type Addon = {
  getStatus(): MacNotificationPermission;
  request(): void;
  bundleId(): string | null;
};

let addon: Addon | null | undefined;

function load(): Addon | null {
  if (addon !== undefined) return addon;
  if (process.platform !== 'darwin') return (addon = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addon = require('@rigxyz/mac-notifications') as Addon;
  } catch {
    addon = null;
  }
  return addon;
}

export function notificationPermission(): MacNotificationPermission {
  return load()?.getStatus() ?? 'unsupported';
}

/** Shows macOS's own prompt the first time; afterwards macOS answers with the stored choice. */
export function requestNotificationPermission(): void {
  load()?.request();
}

/** Rig's own page in System Settings › Notifications (macOS 13+), or the pane itself. */
export async function openNotificationSettings(): Promise<void> {
  const id = load()?.bundleId();
  const url = id
    ? `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(id)}`
    : 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
  await shell.openExternal(url);
}
