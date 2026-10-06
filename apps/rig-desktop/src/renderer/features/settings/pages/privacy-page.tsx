import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { Button } from '@renderer/lib/ui/button';
import { RIG_PRIVACY_URL, RIG_TERMS_URL } from '@shared/urls';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows, SettingsSwitch } from '../settings-row';

/** Settings › Privacy: usage data, error reports, and the policy and terms on the website. */
export function PrivacyPage() {
  return (
    <SettingsRows>
      <UsageDataRow />
      <ErrorReportsRow />
      <LinkRow rowId="privacy-policy" url={RIG_PRIVACY_URL} />
      <LinkRow rowId="terms" url={RIG_TERMS_URL} />
    </SettingsRows>
  );
}

/**
 * Anonymous usage and error telemetry. `main/lib/telemetry.ts`'s own header
 * comment says exactly what leaves the machine (no document contents, names
 * or emails, ever). Default on.
 */
function UsageDataRow() {
  const row = settingsRow('usage-data')!;
  const queryClient = useQueryClient();
  const { data: enabled } = useQuery({
    queryKey: ['rig', 'telemetry', 'enabled'],
    queryFn: () => rpc.telemetry.isUserEnabled(),
  });
  const checked = enabled ?? true;

  const toggle = () => {
    void rpc.telemetry.setEnabled(!checked).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['rig', 'telemetry', 'enabled'] });
    });
  };

  return (
    <SettingsRow
      id={row.id}
      label={row.label}
      description={row.description}
      htmlFor="telemetry-enabled"
      control={<SettingsSwitch id="telemetry-enabled" label={row.label} checked={checked} onToggle={toggle} />}
    />
  );
}

/**
 * Error and crash reports: their own switch, on by default, and they go even
 * when usage data is off (`isErrorEvent` in `main/lib/telemetry.ts` says
 * which events count).
 */
function ErrorReportsRow() {
  const row = settingsRow('error-reports')!;
  const queryClient = useQueryClient();
  const { data: enabled } = useQuery({
    queryKey: ['rig', 'telemetry', 'errorReports'],
    queryFn: () => rpc.telemetry.isErrorReportsEnabled(),
  });
  const checked = enabled ?? true;

  const toggle = () => {
    void rpc.telemetry.setErrorReportsEnabled(!checked).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['rig', 'telemetry', 'errorReports'] });
    });
  };

  return (
    <SettingsRow
      id={row.id}
      label={row.label}
      description={row.description}
      htmlFor="error-reports-enabled"
      control={<SettingsSwitch id="error-reports-enabled" label={row.label} checked={checked} onToggle={toggle} />}
    />
  );
}

function LinkRow({ rowId, url }: { rowId: string; url: string }) {
  const row = settingsRow(rowId)!;
  return (
    <SettingsRow
      id={row.id}
      label={row.label}
      description={row.description}
      control={
        <Button variant="ghost" size="xs" onClick={() => confirmOpenExternalLink(url)} aria-label={`Open ${row.label}`}>
          Open
          <ExternalLink strokeWidth={1.5} />
        </Button>
      }
    />
  );
}
