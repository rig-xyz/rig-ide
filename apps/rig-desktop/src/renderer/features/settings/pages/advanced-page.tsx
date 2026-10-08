import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows, SettingsSwitch } from '../settings-row';

/** Settings › Advanced: settings still settling, and the Rig folder, which few should change. Replaces the old Experimental section. */
export function AdvancedPage() {
  return (
    <SettingsRows>
      <RoomThemesRow />
      <SpacesDiskCacheRow />
      <RigHomeRow />
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

/**
 * The managed Rig folder: the current path (tilde-shortened, from
 * `rpc.rig.home.get()`) and a native picker that writes the new `home` key
 * via `rpc.rig.home.set`. Only where NEW rigs land changes; existing ones
 * stay put (the row menu's "Move to Rig folder" is for that).
 *
 * This is the only place location comes up at all, so it keeps the create
 * dialog's old heads-up: `rpc.rig.home.set` carries no location guard of
 * its own, and the real enforcement is still `rig init`'s dangerous-location
 * and non-empty-folder checks when a rig is actually created there.
 */
function RigHomeRow() {
  const row = settingsRow('rig-folder')!;
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['rig', 'home', 'get'],
    queryFn: () => rpc.rig.home.get(),
  });

  const change = async () => {
    setChanging(true);
    setError(null);
    try {
      const picked = await rpc.app.openSelectDirectoryDialog({
        title: 'Choose your Rig folder',
        message: 'New rigs will be created here.',
      });
      if (!picked) return;
      const result = await rpc.rig.home.set({ home: picked });
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['rig', 'home'] });
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "Couldn't open the folder picker.");
    } finally {
      setChanging(false);
    }
  };

  return (
    <SettingsRow
      id={row.id}
      label={row.label}
      description={row.description}
      detail={
        <div className="mt-1.5 flex flex-col gap-1">
          <p className="text-text-secondary min-w-0 truncate font-mono text-xs" title={data?.home} data-testid="rig-home-path">
            {data?.displayPath ?? '…'}
          </p>
          {error && <p className="text-danger text-xs">{error}</p>}
          <p className="text-text-muted flex items-start gap-1.5 text-xs">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
            Change it at your own risk, since Rig won't merge into a folder that already has files.
          </p>
        </div>
      }
      control={
        <Button variant="outline" size="xs" onClick={() => void change()} disabled={changing}>
          {changing ? 'Choosing…' : 'Change…'}
        </Button>
      }
    />
  );
}
