import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows, SettingsSwitch } from '../settings-row';

/** Settings › Advanced: settings still settling. Replaces the old Experimental section. */
export function AdvancedPage() {
  return (
    <SettingsRows>
      <RoomThemesRow />
      <SpacesDiskCacheRow />
    </SettingsRows>
  );
}

/**
 * `roomThemesEnabled`: the Room asks the relay for its themes only while this
 * is on. Read live by open Rooms (`useRoomThemesEnabled`), so no reload needed.
 */
function RoomThemesRow() {
  const row = settingsRow('topics')!;
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['rig', 'settings', 'roomThemesEnabled'],
    queryFn: () => rpc.rig.settings.get(),
  });
  const enabled = data?.roomThemesEnabled ?? false;

  const toggle = () => {
    void rpc.rig.settings.set({ roomThemesEnabled: !enabled }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['rig', 'settings', 'roomThemesEnabled'] });
    });
  };

  return (
    <SettingsRow
      id={row.id}
      label={row.label}
      description={row.description}
      htmlFor="room-themes-enabled"
      control={<SettingsSwitch id="room-themes-enabled" label={row.label} checked={enabled} onToggle={toggle} />}
    />
  );
}

/**
 * `spacesRoomDiskCache`: each space's last state kept on this computer, so
 * the first open after launch shows at once and then catches up. Turning it
 * off also deletes what was kept. Takes effect the next time a space opens.
 */
function SpacesDiskCacheRow() {
  const row = settingsRow('open-spaces-instantly')!;
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['rig', 'settings', 'spacesRoomDiskCache'],
    queryFn: () => rpc.rig.settings.get(),
  });
  const enabled = data?.spacesRoomDiskCache ?? false;

  const toggle = () => {
    void rpc.rig.settings
      .set({ spacesRoomDiskCache: !enabled })
      .then(() => (enabled ? rpc.rig.roomCache.clear() : undefined))
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['rig', 'settings', 'spacesRoomDiskCache'] });
      });
  };

  return (
    <SettingsRow
      id={row.id}
      label={row.label}
      description={row.description}
      htmlFor="spaces-disk-cache"
      control={<SettingsSwitch id="spaces-disk-cache" label={row.label} checked={enabled} onToggle={toggle} />}
    />
  );
}
