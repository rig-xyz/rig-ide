import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Sun } from 'lucide-react';
import { rpc } from '@renderer/lib/ipc';
import type { RigSettings } from '@shared/rig/settings';
import { settingsRow } from '../settings-pages';
import {
  SettingsRow,
  SettingsRows,
  SettingsSegmented,
  SettingsSwitch,
  type SegmentOption,
} from '../settings-row';

export type ThemePreference = 'dark' | 'light' | 'system';

const THEME_OPTIONS: readonly SegmentOption<ThemePreference>[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

const QUERY_KEY = ['rig', 'settings', 'general'];

/**
 * Settings › General: Theme, and whether Rig opens when you log in (on unless turned off, so
 * schedules in your spaces keep running after a restart). The Rig folder is in Advanced; updates
 * live in About, beside the version.
 */
export function GeneralPage({
  themePreference,
  onSetThemePreference,
}: {
  themePreference: ThemePreference;
  onSetThemePreference: (next: ThemePreference) => void;
}) {
  const theme = settingsRow('theme')!;
  const atLogin = settingsRow('open-at-login')!;
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: () => rpc.rig.settings.get() });
  const openAtLogin = data?.openAtLogin ?? true;
  const setOpenAtLogin = (next: boolean) => {
    queryClient.setQueryData(QUERY_KEY, (old: RigSettings | undefined) =>
      old ? { ...old, openAtLogin: next } : old
    );
    void rpc.rig.settings.set({ openAtLogin: next }).then(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    });
  };
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
      <SettingsRow
        id={atLogin.id}
        label={atLogin.label}
        description={atLogin.description}
        control={
          <SettingsSwitch
            id="open-at-login"
            label={atLogin.label}
            checked={openAtLogin}
            onToggle={() => setOpenAtLogin(!openAtLogin)}
          />
        }
      />
    </SettingsRows>
  );
}
