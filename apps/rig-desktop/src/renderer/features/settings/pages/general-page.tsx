import { Monitor, Moon, Sun } from 'lucide-react';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows, SettingsSegmented, type SegmentOption } from '../settings-row';

export type ThemePreference = 'dark' | 'light' | 'system';

const THEME_OPTIONS: readonly SegmentOption<ThemePreference>[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

/** Settings › General: Theme. The Rig folder is in Advanced; updates live in About, beside the version. */
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
    </SettingsRows>
  );
}
