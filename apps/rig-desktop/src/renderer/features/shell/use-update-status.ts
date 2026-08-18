import { useCallback, useEffect, useMemo, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import {
  updateAvailableEvent,
  updateCheckingEvent,
  updateDownloadedEvent,
  updateDownloadingEvent,
  updateErrorEvent,
  updateNotAvailableEvent,
  updateProgressEvent,
} from '@shared/events/updateEvents';
import { INITIAL_UPDATE_VIEW_STATE, mapInitialStatus, reduceUpdateState, type UpdateViewState } from './update-status';

/**
 * The live wiring behind `update-status.ts`'s pure reducer — subscribes to
 * every update event the main process actually emits (verified against
 * `update-service.ts`, see that pure module's own header comment) and
 * folds each one through `reduceUpdateState`. Self-contained, like
 * `BriefingSpine`/`PeopleRail` both independently reading the same pulse
 * query key: every caller (Settings → About, the topbar gear's dot, the
 * "ready" toast watcher in `App.tsx`) mounts its OWN instance of this hook
 * rather than sharing one through context — cheap (a handful of IPC
 * listeners), and always consistent since every instance is driven by the
 * same main-process broadcast.
 *
 * Two async reads on mount, raced against the live event stream:
 *   - `rpc.update.getState()` — main's own CURRENT state, in case a check
 *     is already mid-flight (or already resolved) before this mounts.
 *   - `rpc.rig.settings.get()` — `updateLastCheckedAt`/`updateAnnouncedVersion`,
 *     the two pieces of this view state that survive a relaunch.
 * If a live event arrives before either resolves, the event wins (it's
 * strictly newer) — both effects only ever fold onto whatever is current
 * at the time they land, never overwrite a newer live update.
 */
export function useUpdateStatus(): {
  state: UpdateViewState;
  announcedVersion: string | null;
  check: () => void;
  restart: () => void;
  markAnnounced: (version: string) => void;
} {
  const [state, setState] = useState<UpdateViewState>(INITIAL_UPDATE_VIEW_STATE);
  const [announcedVersion, setAnnouncedVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    rpc.update
      .getState()
      .then((result) => {
        if (!alive || !result.success || !result.data) return;
        const s = result.data;
        // `updateService.getState()` return shape is main-only (`UpdateState`,
        // not a shared type) — read structurally rather than importing a
        // main-process type into the renderer.
        setState((prev) => ({
          ...prev,
          status: mapInitialStatus(s.status),
          currentVersion: s.currentVersion,
          availableVersion: s.availableVersion ?? null,
          percent: s.downloadProgress?.percent ?? null,
          errorMessage: s.error ?? null,
        }));
      })
      .catch(() => {});

    rpc.rig.settings
      .get()
      .then((settings) => {
        if (!alive) return;
        setAnnouncedVersion(settings.updateAnnouncedVersion);
        setState((prev) => ({ ...prev, lastCheckedAt: settings.updateLastCheckedAt }));
      })
      .catch(() => {});

    const offs = [
      events.on(updateCheckingEvent, () => setState((s) => reduceUpdateState(s, { kind: 'checking' }, Date.now()))),
      events.on(updateAvailableEvent, (payload) =>
        setState((s) => reduceUpdateState(s, { kind: 'available', version: payload.version }, Date.now()))
      ),
      events.on(updateNotAvailableEvent, () =>
        setState((s) => reduceUpdateState(s, { kind: 'notAvailable' }, Date.now()))
      ),
      events.on(updateDownloadingEvent, (payload) =>
        setState((s) => reduceUpdateState(s, { kind: 'downloading', version: payload.version }, Date.now()))
      ),
      events.on(updateProgressEvent, (payload) =>
        setState((s) => reduceUpdateState(s, { kind: 'progress', percent: payload.percent }, Date.now()))
      ),
      events.on(updateDownloadedEvent, (payload) =>
        setState((s) => reduceUpdateState(s, { kind: 'downloaded', version: payload.version }, Date.now()))
      ),
      events.on(updateErrorEvent, (payload) =>
        setState((s) => reduceUpdateState(s, { kind: 'error', message: payload.message }, Date.now()))
      ),
    ];

    return () => {
      alive = false;
      for (const off of offs) off();
    };
  }, []);

  const check = useCallback(() => {
    void rpc.update.check();
  }, []);

  const restart = useCallback(() => {
    void rpc.update.quitAndInstall();
  }, []);

  // Written the moment the toast/UI decides to show a version — not on
  // dismiss, which might never fire if the user quits without touching it.
  const markAnnounced = useCallback((version: string) => {
    setAnnouncedVersion(version);
    void rpc.rig.settings.set({ updateAnnouncedVersion: version });
  }, []);

  // Memoized so the returned object is referentially STABLE across renders
  // where `state`/`announcedVersion` haven't actually changed (`check`/
  // `restart`/`markAnnounced` already are, via their own empty-dep
  // `useCallback`s) — lets a caller's own `useEffect` depend on the whole
  // return value honestly (satisfies exhaustive-deps for real, rather than
  // suppressing it) without refiring on every unrelated render.
  return useMemo(
    () => ({ state, announcedVersion, check, restart, markAnnounced }),
    [state, announcedVersion, check, restart, markAnnounced]
  );
}
