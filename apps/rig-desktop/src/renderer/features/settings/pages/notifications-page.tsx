import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Bell, BellOff } from 'lucide-react';
import { useState } from 'react';
import {
  useNotificationPermission,
  useNotificationSummary,
  useRequestNotificationPermission,
} from '@renderer/features/notifications/use-notifications';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import {
  DEFAULT_NOTIFICATION_PREFS,
  levelLabel,
  SCOPE_LABEL,
  type BannerScope,
  type NotificationPrefs,
} from '@shared/rig/notifications';
import type { RigSettings } from '@shared/rig/settings';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows, SettingsSegmented, SettingsSwitch, type SegmentOption } from '../settings-row';

const SCOPE_OPTIONS: readonly SegmentOption<BannerScope>[] = [
  { id: 'everything', label: SCOPE_LABEL.everything, icon: Bell },
  { id: 'aboutMe', label: SCOPE_LABEL.aboutMe, icon: AtSign },
  { id: 'nothing', label: SCOPE_LABEL.nothing, icon: BellOff },
];

const SCOPE_HINT: Record<BannerScope, string> = {
  everything: 'Every message and comment, in spaces set to Everything.',
  aboutMe: 'Mentions, replies, your agents and invites.',
  nothing: 'No banners, but Activity and the counts still keep track.',
};

const QUERY_KEY = ['rig', 'settings', 'notifications'];

/**
 * Settings › Notifications (`rig/docs/notifications-spec.md` §5). macOS's
 * side first (whether banners can show at all, with the fix one click away,
 * and the test), then one choice of what gets a banner instead of a switch
 * per type, then three plain switches. Spaces whose own level differs are
 * listed last, so the whole picture fits on one page. Prefs are local to
 * this computer (`rig settings`); a space's level lives on the relay.
 */
export function NotificationsPage() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: () => rpc.rig.settings.get() });
  const prefs = data?.notifications ?? DEFAULT_NOTIFICATION_PREFS;
  const summary = useNotificationSummary();
  const differ = summary.spaces.filter((space) => space.level !== 'all');

  const setPrefs = (next: NotificationPrefs) => {
    // Optimistic, so a second quick change builds on the first rather than
    // on the last fetched prefs (which would undo it).
    queryClient.setQueryData(QUERY_KEY, (old: RigSettings | undefined) => (old ? { ...old, notifications: next } : old));
    void rpc.rig.settings.set({ notifications: next }).then(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    });
  };

  const scope = settingsRow('banner-scope')!;
  const quiet = settingsRow('quiet-while-using')!;
  const sound = settingsRow('sound')!;
  const dock = settingsRow('dock-badge')!;
  const bannersOff = prefs.banners === 'nothing';

  return (
    <SettingsRows>
      <PermissionRow />
      <SettingsRow
        id={scope.id}
        label={scope.label}
        description={SCOPE_HINT[prefs.banners]}
        control={
          <SettingsSegmented
            label={scope.label}
            value={prefs.banners}
            options={SCOPE_OPTIONS}
            onChange={(banners) => setPrefs({ ...prefs, banners })}
          />
        }
      />
      <SettingsRow
        id={quiet.id}
        label={quiet.label}
        description={quiet.description}
        htmlFor="notifications-only-away"
        disabled={bannersOff}
        control={
          <SettingsSwitch
            id="notifications-only-away"
            label={quiet.label}
            checked={prefs.onlyWhenAway}
            disabled={bannersOff}
            onToggle={() => setPrefs({ ...prefs, onlyWhenAway: !prefs.onlyWhenAway })}
          />
        }
      />
      <SettingsRow
        id={sound.id}
        label={sound.label}
        description={sound.description}
        htmlFor="notifications-sound"
        disabled={bannersOff}
        control={
          <SettingsSwitch
            id="notifications-sound"
            label={sound.label}
            checked={prefs.sound}
            disabled={bannersOff}
            onToggle={() => setPrefs({ ...prefs, sound: !prefs.sound })}
          />
        }
      />
      <SettingsRow
        id={dock.id}
        label={dock.label}
        description={dock.description}
        htmlFor="notifications-dock-badge"
        control={
          <SettingsSwitch
            id="notifications-dock-badge"
            label={dock.label}
            checked={prefs.dockBadge}
            onToggle={() => setPrefs({ ...prefs, dockBadge: !prefs.dockBadge })}
          />
        }
      />
      {differ.length > 0 && (
        <SettingsRow
          label="Set differently"
          description={
            <span data-testid="notifications-set-differently">
              {differ.map((space, i) => (
                <span key={space.bindingId}>
                  {i > 0 && ' · '}
                  <span className="text-text-secondary">#{space.name ?? 'space'}</span> {levelLabel(space.level)}
                </span>
              ))}
            </span>
          }
        />
      )}
    </SettingsRows>
  );
}

/**
 * macOS's side: banners only appear once macOS allows them for Rig, and
 * Electron doesn't ask on its own. Off: the fix is one click (Rig's own page
 * in System Settings). Never asked: one click asks. On: a test to see one.
 */
function PermissionRow() {
  const row = settingsRow('macos-banners')!;
  const permission = useNotificationPermission();
  const request = useRequestNotificationPermission();
  const [testError, setTestError] = useState<string | null>(null);
  const [testHint, setTestHint] = useState<string | null>(null);
  const sendTest = async () => {
    setTestError(null);
    setTestHint(null);
    const result = await rpc.rig.notifications.test();
    if (!result.success) setTestError(result.error.message);
    // macOS hides banners from the app in front, so the test waits for you to switch away.
    else if (result.data.waitingForAway) setTestHint('Switch to another app and the test banner will show there.');
  };
  if (permission === null) return null;

  const status =
    permission === 'denied'
      ? { dot: 'bg-warning', text: 'Banners are off for Rig in macOS.' }
      : permission === 'notDetermined'
        ? { dot: 'bg-text-muted', text: "macOS hasn't been asked about banners yet." }
        : permission === 'authorized' || permission === 'provisional'
          ? { dot: 'bg-success', text: 'Banners are on in macOS.' }
          : null;

  return (
    <SettingsRow
      id={row.id}
      label={row.label}
      description={
        status ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', status.dot)} />
            <span data-testid="notification-permission">{status.text}</span>
          </span>
        ) : (
          row.description
        )
      }
      detail={
        <>
          {testError && <p className="text-danger mt-1 text-xs">{testError}</p>}
          {testHint && (
            <p className="text-text-secondary mt-1 text-xs" data-testid="notification-test-hint">
              {testHint}
            </p>
          )}
        </>
      }
      control={
        permission === 'denied' ? (
          <Button variant="outline" size="xs" onClick={() => void rpc.rig.notifications.openSystemSettings()}>
            Open System Settings
          </Button>
        ) : permission === 'notDetermined' ? (
          <Button size="xs" onClick={request}>
            Turn on
          </Button>
        ) : (
          <Button variant="outline" size="xs" onClick={() => void sendTest()}>
            Send a test
          </Button>
        )
      }
    />
  );
}
