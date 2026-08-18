import { relativeTime } from '@renderer/features/chat/session-history';

/**
 * Round: make app updates visible. `main/core/updates/update-service.ts`
 * already checks on a schedule, downloads, and tracks all of this —
 * nothing here talks to Electron or IPC. This module only folds the event
 * stream the main process actually emits (`shared/events/updateEvents.ts`,
 * verified against source, not assumed) into one small view model, and
 * reads that view model back out as a status line / button descriptor /
 * announce-once decision. Kept fully pure and side-effect-free so it's
 * testable without mocking RPC — the wiring (subscribing to the real
 * events, calling the real RPCs) lives in `use-update-status.ts`.
 *
 * Event inventory verified directly against `update-service.ts` (not the
 * brief's own list, which was close but incomplete):
 *   - `updateCheckingEvent` (void), `updateNotAvailableEvent` (void)
 *   - `updateAvailableEvent` — DOES carry the version: `{ version, updateInfo }`
 *   - `updateDownloadingEvent` — NOT in the original brief. Fires once,
 *     right when a download starts (`{ version }`), before the first
 *     `updateProgressEvent`.
 *   - `updateProgressEvent` — `{ percent, transferred, total, bytesPerSecond }`.
 *     `percent` IS a real number (electron-updater's own `ProgressInfo`),
 *     never absent — the "no fabricated percent" rule in `deriveUpdateStatusLine`
 *     below is defensive for the one tick before it arrives, not a real gap.
 *   - `updateDownloadedEvent` — `{ version }`.
 *   - `updateInstallingEvent` (void) — NOT in the original brief either.
 *     Fires when "Restart to update" is clicked, ~250ms before the app
 *     quits. No `UpdateEvent` variant below models it — there's no
 *     meaningful window to show new UI in before the process exits; the
 *     button click itself is the user-visible feedback.
 *   - `updateErrorEvent` — `{ message }`.
 *
 * SECOND finding, not in the brief: `autoUpdater.autoDownload = false` —
 * nothing downloads an available update automatically today. Per the
 * brief's own "auto-update is the right beta default" framing (and its
 * 5-state list has no "available, click to download" state at all), main
 * now auto-triggers the download the moment one's found
 * (`update-service.ts`'s `'update-available'` handler) — see that file's
 * own comment. Without this, the feature never reaches 'downloading'/
 * 'ready' on its own.
 */

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export type UpdateViewState = {
  status: UpdateStatus;
  currentVersion: string;
  /** The version being downloaded, or that's ready — null before one's ever been found this session. */
  availableVersion: string | null;
  /** 0-100, or null before the first progress tick of the current download. */
  percent: number | null;
  errorMessage: string | null;
  /** ms epoch — when a check last genuinely RESOLVED (found-or-not), never when a check merely started. Persisted across restarts (`RigSettings.updateLastCheckedAt`). */
  lastCheckedAt: number | null;
};

export const INITIAL_UPDATE_VIEW_STATE: UpdateViewState = {
  status: 'idle',
  currentVersion: '',
  availableVersion: null,
  percent: null,
  errorMessage: null,
  lastCheckedAt: null,
};

/** Mirrors the main process's own event stream — one variant per channel that has meaningful UI state (`'installing'` deliberately excluded, see this file's header comment). */
export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'notAvailable' }
  | { kind: 'downloading'; version: string }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

/**
 * `now` is threaded in (never `Date.now()` internally) so this stays pure
 * and every timestamp it produces is exactly what the test passed in.
 */
export function reduceUpdateState(state: UpdateViewState, event: UpdateEvent, now: number): UpdateViewState {
  switch (event.kind) {
    case 'checking':
      return { ...state, status: 'checking', errorMessage: null };
    case 'available':
      // Still shown as "checking" — main auto-downloads the instant one's
      // found (see this file's header comment), so a user essentially
      // never sees a distinct "found, about to download" moment worth its
      // own line. A genuine resolution of the check either way, so
      // `lastCheckedAt` advances.
      return { ...state, status: 'checking', availableVersion: event.version, lastCheckedAt: now };
    case 'notAvailable':
      return { ...state, status: 'idle', availableVersion: null, lastCheckedAt: now };
    case 'downloading':
      return { ...state, status: 'downloading', availableVersion: event.version, percent: null, errorMessage: null };
    case 'progress':
      return { ...state, status: 'downloading', percent: event.percent };
    case 'downloaded':
      return { ...state, status: 'ready', availableVersion: event.version, percent: 100 };
    case 'error':
      // Availability/progress already known are left as-is (matches
      // `update-service.ts`'s own error handler, which preserves
      // `availableVersion`/`updateInfo` across a transient failure) — a
      // failed check must never look like "up to date" (the brief's own
      // non-negotiable), and `lastCheckedAt` does NOT advance: an attempt
      // that failed is not a resolution.
      return { ...state, status: 'error', errorMessage: event.message };
  }
}

/** Main's own `UpdateState['status']` has two extra values this view never distinguishes — folded onto the nearest honest equivalent for the ONE initial snapshot read (`rpc.update.getState()`); every value after that comes from the live event stream via `reduceUpdateState` above. */
export function mapInitialStatus(mainStatus: string): UpdateStatus {
  switch (mainStatus) {
    case 'checking':
    case 'available':
      return 'checking';
    case 'downloading':
      return 'downloading';
    case 'downloaded':
    case 'installing':
      return 'ready';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * The one status line (Settings → About). Every branch matches the
 * brief's own wording. "Real progress or none" (a non-negotiable): the
 * percent only ever comes from `state.percent`, never invented when it's
 * `null`.
 */
export function deriveUpdateStatusLine(state: UpdateViewState, now: number): string {
  switch (state.status) {
    case 'checking':
      return 'Checking…';
    case 'downloading': {
      const label = state.availableVersion ? `Rig ${state.availableVersion}` : 'Update';
      return state.percent === null ? `${label} · downloading` : `${label} · downloading ${Math.round(state.percent)}%`;
    }
    case 'ready':
      return state.availableVersion ? `Rig ${state.availableVersion} ready` : 'Update ready';
    case 'error':
      // Never "up to date" — a distinct, honest line even though the
      // underlying `errorMessage` (network failure, etc.) isn't shown here
      // verbatim; the About row has room for it separately if needed.
      return "Couldn't check for updates";
    case 'idle':
      return state.lastCheckedAt === null ? 'Up to date' : `Up to date · checked ${relativeTime(state.lastCheckedAt, now)}`;
  }
}

export type UpdateAction =
  | { kind: 'check'; label: 'Check for updates'; disabled: boolean }
  | { kind: 'restart'; label: 'Restart to update' };

/** `'downloading'`/`'checking'` disable the button (nothing to do mid-flight, no double-checking); `'ready'` swaps it to Restart; everything else (idle/error) offers a retry — an error must never leave the user with no way forward. */
export function deriveUpdateAction(status: UpdateStatus): UpdateAction {
  if (status === 'ready') return { kind: 'restart', label: 'Restart to update' };
  return { kind: 'check', label: 'Check for updates', disabled: status === 'checking' || status === 'downloading' };
}

/**
 * The topbar gear's accent dot — visible ONLY once a download has
 * genuinely finished and is installable, per the brief's own non-
 * negotiable ("the dot never appears for an update that isn't actually
 * downloaded"). No separate test block below: this is `status === 'ready'`
 * by definition, already exhaustively covered by `reduceUpdateState`'s own
 * tests for how a state reaches `'ready'` in the first place.
 */
export function isUpdateReady(state: UpdateViewState): boolean {
  return state.status === 'ready';
}

/**
 * The toast's announce-once decision — persisted separately from
 * `UpdateViewState` (`RigSettings.updateAnnouncedVersion`, survives a
 * relaunch) so a version already shown never re-nags, while a NEWER
 * version downloaded later still gets its own toast.
 */
export function shouldAnnounceUpdate(state: UpdateViewState, announcedVersion: string | null): boolean {
  return state.status === 'ready' && state.availableVersion !== null && state.availableVersion !== announcedVersion;
}
