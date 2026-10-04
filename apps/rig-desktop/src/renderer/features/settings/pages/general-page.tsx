import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Sun, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { deriveUpdateAction, deriveUpdateStatusLine } from '@renderer/features/shell/update-status';
import { useUpdateStatus } from '@renderer/features/shell/use-update-status';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows, SettingsSegmented, type SegmentOption } from '../settings-row';

export type ThemePreference = 'dark' | 'light' | 'system';

const THEME_OPTIONS: readonly SegmentOption<ThemePreference>[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

/** Settings › General: Theme, the Rig folder, Updates. */
export function GeneralPage({
  themePreference,
  onSetThemePreference,
}: {
  themePreference: ThemePreference;
  onSetThemePreference: (next: ThemePreference) => void;
}) {
  const theme = settingsRow('theme')!;
  return (
    <SettingsRows>
      <SettingsRow
        id={theme.id}
        label={theme.label}
        description={theme.description}
        control={
          <SettingsSegmented label="Theme" value={themePreference} options={THEME_OPTIONS} onChange={onSetThemePreference} />
        }
      />
      <RigHomeRow />
      <AppUpdateRow />
    </SettingsRows>
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

/**
 * Updates: one live status line (`deriveUpdateStatusLine`) and one action
 * (`deriveUpdateAction`) that swaps from "Check for updates" to "Restart to
 * update" only once a download is genuinely ready. `useUpdateStatus` is the
 * shared hook; the topbar gear's dot and the "ready" toast (`App.tsx`) each
 * mount their own instance, all driven by the same main-process broadcast.
 */
function AppUpdateRow() {
  const row = settingsRow('updates')!;
  const { state, check, restart } = useUpdateStatus();
  const [now, setNow] = useState(() => Date.now());
  // "checked Xh ago" goes stale just sitting open; a light tick keeps it honest.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const { data: supported } = useQuery({
    queryKey: ['rig', 'updates', 'supported'],
    queryFn: () => rpc.update.isSupported(),
    staleTime: Infinity,
  });

  // Development builds can't self-update (electron-updater needs a packed app).
  if (supported === false) {
    return (
      <SettingsRow
        id={row.id}
        label={row.label}
        description="This development build doesn't update itself."
        descriptionTestId="updates-dev-build"
      />
    );
  }

  const action = deriveUpdateAction(state.status);
  return (
    <SettingsRow
      id={row.id}
      label={row.label}
      description={row.description}
      detail={
        <p
          className={cn('mt-1 text-xs', state.status === 'error' ? 'text-danger' : 'text-text-secondary')}
          data-testid="update-status-line"
        >
          {deriveUpdateStatusLine(state, now)}
        </p>
      }
      control={
        <Button
          variant="outline"
          size="xs"
          onClick={action.kind === 'restart' ? restart : check}
          disabled={action.kind === 'check' && action.disabled}
        >
          {action.label}
        </Button>
      }
    />
  );
}
