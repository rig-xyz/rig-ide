import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { deriveCliVersionRow } from '@renderer/features/shell/cli-versions';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import { PRODUCT_NAME } from '@shared/app-identity';
import { RIG_WEBSITE_URL } from '@shared/urls';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows } from '../settings-row';

/**
 * Settings › About: the app's version, then one comparison row each for the
 * Rig command line and sync (tapd): bundled vs the user's own PATH install
 * (`rpc.rig.bundledCli.getVersionReport`, a manifest read plus a cached
 * `--version` probe; see `main/rig/bundled-cli.ts`). The rows answer "do my
 * bundled and local installs conflict?": matching versions collapse to one
 * quiet value, a mismatch shows both in the warning tone, and the source the
 * app actually runs carries an "in use" marker. Rows fill in async.
 */
export function AboutPage() {
  const { data: appVersion } = useQuery({
    queryKey: ['rig', 'app', 'version'],
    queryFn: () => rpc.app.getAppVersion(),
  });
  const { data: report } = useQuery({
    queryKey: ['rig', 'bundledCli', 'versionReport'],
    queryFn: () => rpc.rig.bundledCli.getVersionReport(),
  });
  const app = settingsRow('app-version')!;
  const cli = settingsRow('cli-version')!;
  const sync = settingsRow('sync-version')!;
  const website = settingsRow('website')!;

  return (
    <SettingsRows>
      <SettingsRow
        id={app.id}
        label={PRODUCT_NAME}
        description={app.description}
        control={<p className="text-text-secondary font-mono text-xs">{appVersion ?? '…'}</p>}
      />
      <SettingsRow id={cli.id} label={cli.label} description={cli.description} control={<CliVersion sources={report?.rig} />} />
      <SettingsRow id={sync.id} label={sync.label} description={sync.description} control={<CliVersion sources={report?.tapd} />} />
      <SettingsRow
        id={website.id}
        label={website.label}
        description={website.description}
        control={
          <Button variant="ghost" size="xs" onClick={() => confirmOpenExternalLink(RIG_WEBSITE_URL)}>
            userig.xyz
            <ExternalLink strokeWidth={1.5} />
          </Button>
        }
      />
    </SettingsRows>
  );
}

/**
 * One tool's bundled-vs-local value. The "in use" marker renders only when
 * BOTH installs exist; with a single install it's trivially the one that
 * runs. Under it, up to two more quiet mono lines: the local install's own
 * resolved path (self-diagnosing a name collision or stale install) and,
 * only when the PATH disagrees with itself, "N installs found".
 */
function CliVersion({
  sources,
}: {
  sources:
    | {
        bundled: string | null;
        local: string | null;
        localPath: string | null;
        multipleInstalls: { count: number; usingPath: string } | null;
      }
    | undefined;
}) {
  const row = sources ? deriveCliVersionRow(sources) : null;
  if (row === null) return <p className="text-text-muted font-mono text-xs">checking…</p>;
  return (
    <div className="flex max-w-[22rem] min-w-0 flex-col items-end gap-0.5">
      <p
        className={cn(
          'min-w-0 truncate text-right font-mono text-xs',
          row.tone === 'warning' ? 'text-warning' : 'text-text-secondary'
        )}
      >
        {row.label}
        {(row.kind === 'equal' || row.kind === 'conflict') && <span className="text-text-muted"> · in use: {row.inUse}</span>}
      </p>
      {row.localPath && (
        <p className="text-text-muted max-w-full min-w-0 truncate text-right font-mono text-xs">{row.localPath}</p>
      )}
      {row.multipleInstallsNote && (
        <p className="text-text-muted max-w-full min-w-0 truncate text-right text-xs">{row.multipleInstallsNote}</p>
      )}
    </div>
  );
}
