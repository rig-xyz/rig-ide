import { app, BrowserWindow, Notification } from 'electron';
import { err, ok, type Result } from '@emdash/shared';
import { createMainWindow, getMainWindow } from '@main/app/window';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  NOTIFICATION_LEVELS,
  openTargetOf,
  rigNotificationsChangedChannel,
  rigOpenInvitesChannel,
  rigOpenSpaceAtChannel,
  type MacNotificationPermission,
  type NotificationLevel,
  type OpenSpaceAt,
  type RigNotification,
  type RigNotificationSummary,
} from '@shared/rig/notifications';
import { resolveSelfUserId } from '../account';
import { activeMac } from '../active-mac-instance';
import { notificationPermission, openNotificationSettings, requestNotificationPermission } from './permission';
import { DeepLinkInbox } from '../deep-link-inbox';
import { rigSettingsStore } from '../settings-instance';
import { BannerPresenter, type BannerFactory } from './presenter';
import * as relay from './relay';
import { NotificationService } from './service';
import { readSse } from './sse';

/**
 * Boot wiring for notifications: the real banners (Electron `Notification`),
 * the Dock badge, window focus, and where a click goes. The
 * logic lives in `service.ts` and `presenter.ts`, which import no Electron.
 */

const liveBanners = new Set<Notification>();

const electronBanner: BannerFactory = (spec) => {
  if (!Notification.isSupported()) return { close() {} };
  const n = new Notification({
    title: spec.title,
    ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
    body: spec.body,
    silent: spec.silent,
  });
  // Electron drops a Notification's handlers once it's garbage collected,
  // so live ones are kept here until they're clicked or closed.
  liveBanners.add(n);
  const release = () => liveBanners.delete(n);
  n.on('click', () => {
    release();
    spec.onClick();
  });
  n.on('close', () => {
    release();
    spec.onClose();
  });
  n.on('failed', (_e, error) => {
    release();
    log.warn('notifications: banner failed', { error: String(error) });
  });
  n.show();
  return {
    close() {
      release();
      n.close();
    },
  };
};

/**
 * macOS hides a banner from the app in front, and Settings' "Send a test"
 * is always pressed with Rig in front. So the test waits until Rig isn't
 * focused, the same moment a real banner would show, and gives up after a
 * minute. One at a time: a second press replaces the first.
 */
const TEST_WAIT_MS = 60_000;
let cancelPendingTest: (() => void) | null = null;

function showTestBanner(): void {
  electronBanner({
    title: 'Notifications are on',
    body: 'This is what Rig will show when someone needs you.',
    silent: !rigSettingsStore.get().notifications.sound,
    onClick: focusWindow,
    onClose: () => {},
  });
}

function showTestWhenAway(): boolean {
  cancelPendingTest?.();
  if (!BrowserWindow.getFocusedWindow()) {
    showTestBanner();
    return false;
  }
  // A blur can be one window handing focus to another; look again a beat later.
  const onBlur = () => {
    setTimeout(() => {
      if (BrowserWindow.getFocusedWindow()) return;
      cancelPendingTest?.();
      showTestBanner();
    }, 50);
  };
  const timer = setTimeout(() => cancelPendingTest?.(), TEST_WAIT_MS);
  app.on('browser-window-blur', onBlur);
  cancelPendingTest = () => {
    clearTimeout(timer);
    app.off('browser-window-blur', onBlur);
    cancelPendingTest = null;
  };
  return true;
}

function focusWindow(): void {
  const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) {
    if (app.isReady()) createMainWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
}

function setBadge(count: number): void {
  const text = count <= 0 ? '' : count > 99 ? '99+' : String(count);
  if (process.platform === 'darwin') app.dock?.setBadge(text);
  else app.setBadgeCount(Math.max(0, count));
}

/**
 * Where a click or a `rig://space/...` link goes. Held until the renderer
 * says it's listening (`consumePendingOpen`), like join links in
 * `../deep-link.ts`: a click can arrive while the window is still loading.
 */
export const openSpaceInbox = new DeepLinkInbox<OpenSpaceAt>((target) => events.emit(rigOpenSpaceAtChannel, target));

function openFromBanner(rows: RigNotification[]): void {
  focusWindow();
  const latest = rows[rows.length - 1]!;
  void relay.markRead({ ids: rows.map((r) => r.id) }).then(() => notificationService.refresh());
  if (latest.type === 'invite') {
    events.emit(rigOpenInvitesChannel, undefined);
    return;
  }
  const target = openTargetOf(latest);
  if (target) openSpaceInbox.push(target);
}

export const presenter = new BannerPresenter({
  factory: electronBanner,
  now: () => Date.now(),
  sound: () => rigSettingsStore.get().notifications.sound,
  onClick: openFromBanner,
});

export const notificationService = new NotificationService({
  context: relay.relayContext,
  selfUserId: async () => {
    const res = await resolveSelfUserId();
    return res.success ? res.data : null;
  },
  list: relay.listNotifications,
  summary: relay.fetchSummary,
  stream: readSse,
  presenter,
  setBadge,
  emitChanged: (reason) => events.emit(rigNotificationsChangedChannel, { reason }),
  prefs: () => rigSettingsStore.get().notifications,
  cursor: {
    get: (account) => rigSettingsStore.get().notificationCursorByAccount[account] ?? null,
    set: (account, id) => {
      if (rigSettingsStore.get().notificationCursorByAccount[account] === id) return;
      rigSettingsStore.set({ notificationCursorByAccount: { [account]: id } });
    },
  },
  appFocused: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()),
  usingAnotherMac: () => activeMac.usingAnotherMac(),
  markRead: (ids) => relay.markRead({ ids }),
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    }),
  log,
});

/** The signed-in account changed (`../auth.ts`): start over for whoever is signed in now. */
export function restartNotifications(): void {
  notificationService.restart();
}

/** Called once at boot, after rig settings are loaded. */
export function startNotifications(): void {
  let lastPrefs = rigSettingsStore.get().notifications;
  rigSettingsStore.subscribe((settings) => {
    if (settings.notifications === lastPrefs) return;
    lastPrefs = settings.notifications;
    notificationService.prefsChanged();
  });
  notificationService.start();
}

/** `status` is the relay's HTTP status when it answered (absent when unreachable). */
type RelayFailure = { message: string; status?: number };

function fail<T>(res: Result<T, { message: string; status?: number }>): Result<T, RelayFailure> {
  if (res.success) return res;
  const status = 'status' in res.error ? res.error.status : undefined;
  return err({ message: res.error.message, ...(typeof status === 'number' ? { status } : {}) });
}

export const rigNotificationsController = createRPCController({
  /** The last unread summary main holds (rail and Home badges). */
  summary: (): RigNotificationSummary => notificationService.summary(),
  /** Activity: direct rows, newest first, paged with `before`. `bindingId`: only that Space's rows (the Room's For you). */
  activity: async (input: { before?: string; limit?: number; bindingId?: string }): Promise<Result<RigNotification[], RelayFailure>> =>
    fail(
      await relay.listNotifications({
        tier: 'direct',
        limit: input.limit ?? 50,
        before: input.before,
        ...(input.bindingId ? { bindingId: input.bindingId } : {}),
      })
    ),
  markRead: async (input: { ids: string[] } | { all: true }): Promise<Result<void, RelayFailure>> => {
    const res = fail(await relay.markRead(input));
    notificationService.refresh();
    return res;
  },
  /** The Room read up to `seq`, and/or is on screen now (`seen`). */
  markSpaceRead: async (input: {
    bindingId: string;
    seq?: number;
    seen?: boolean;
  }): Promise<Result<void, RelayFailure>> => {
    const res = fail(await relay.markSpaceRead(input.bindingId, { seq: input.seq, seen: input.seen }));
    notificationService.refresh();
    return res;
  },
  getLevel: async (input: { bindingId: string }): Promise<Result<NotificationLevel, RelayFailure>> =>
    fail(await relay.getLevel(input.bindingId)),
  setLevel: async (input: {
    bindingId: string;
    level: NotificationLevel;
  }): Promise<Result<NotificationLevel, RelayFailure>> => {
    if (!NOTIFICATION_LEVELS.includes(input.level)) return err({ message: 'Unknown level.' });
    const res = fail(await relay.setLevel(input.bindingId, input.level));
    notificationService.refresh();
    return res;
  },
  /** The space on screen in a focused window (`null`: none), for focus suppression. */
  setViewing: (input: { bindingId: string | null }): void => notificationService.setViewing(input.bindingId),
  /** macOS's permission for rig: never asked, allowed, or turned off. */
  permission: (): MacNotificationPermission => notificationPermission(),
  /** Shows macOS's prompt (only the first time; it remembers the answer). */
  requestPermission: (): void => requestNotificationPermission(),
  /** Rig's page in System Settings › Notifications. */
  openSystemSettings: async (): Promise<void> => openNotificationSettings(),
  /**
   * Settings' "Send a test". Asks for permission first if macOS never has.
   * `waitingForAway`: Rig is in front, so the banner shows once you switch away.
   */
  test: (): Result<{ waitingForAway: boolean }, RelayFailure> => {
    if (!Notification.isSupported()) return err({ message: 'This system has no notifications.' });
    if (notificationPermission() === 'notDetermined') requestNotificationPermission();
    return ok({ waitingForAway: showTestWhenAway() });
  },
  /** The renderer is listening for opens: hands over one that arrived first. */
  consumePendingOpen: (): OpenSpaceAt | null => openSpaceInbox.drain(),
  /** The renderer went away: queue opens again. */
  releaseOpen: (): void => openSpaceInbox.reset(),
});
