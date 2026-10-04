import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SignInsList } from '@main/rig/pages/page-sign-ins';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { signInSiteFor, type BrowserConnection, type PageSignInRecord, type SignInSite } from '@shared/pages/sign-in-sites';
import { connectFlow } from './connect-flow';
import { ConnectSheet } from './connect-sheet';
import { signInFlow } from './sign-in-flow';
import { Initial, KeepInStepToggle, SignInSheet } from './sign-in-sheet';
import { accountLabel, macFolderName, SIGN_INS_KEY, useSignIns } from './use-sign-ins';

/**
 * Settings › Sign-ins (board 18, revised): connect Chrome once; after that,
 * pages you open beside a chat sign in automatically, one site at a time.
 * Not connected: what it's for and "Connect Chrome". Connected: the profile
 * (Change profile / Disconnect), the sites signed in so far (Remove), and
 * Keep in step. A refused macOS permission is a warning with its action.
 */

const SETTINGS_WHERE = 'settings';

function siteOf(record: PageSignInRecord): SignInSite {
  return { ...signInSiteFor(record.site), name: record.siteName, hosts: record.hosts, checkUrl: record.checkUrl };
}

type Browsers = SignInsList['browsers'];

/** macOS refused rig a browser's data: what to turn on, and the button that goes there. */
function AccessWarning({ browser }: { browser: Browsers[number] }) {
  return (
    <div className="border-warning/40 bg-warning/5 flex items-center gap-3 rounded-control border px-2.5 py-2" data-testid="sign-in-access-denied" data-browser={browser.id}>
      <p className="min-w-0 flex-1 text-xs text-text-primary">
        To use {browser.name}'s sign-ins, turn on {macFolderName(browser.name)} under Privacy & Security › Files & Folders › Rig.
      </p>
      <Button size="xs" variant="outline" onClick={() => void rpc.rig.pages.openPrivacySettings()}>
        Open System Settings
      </Button>
    </div>
  );
}

/** The connected profile, with Change profile and Disconnect. */
function ConnectionRow({ connection }: { connection: BrowserConnection }) {
  const queryClient = useQueryClient();
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="sign-in-connection">
      <Initial text={connection.email ?? connection.profileName} />
      <span className="min-w-0 flex-1 truncate text-text-primary">
        <b className="font-medium">{connection.browserName}</b> · {connection.profileName}
        {connection.email && <span className="text-text-muted"> · {connection.email}</span>}
      </span>
      <Button size="xs" variant="ghost" onClick={() => void connectFlow.start(SETTINGS_WHERE)}>
        Change profile
      </Button>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => void rpc.rig.pages.disconnect({}).then(() => queryClient.invalidateQueries({ queryKey: SIGN_INS_KEY }))}
      >
        Disconnect
      </Button>
    </div>
  );
}

function SiteRow({ record, onSheet }: { record: PageSignInRecord; onSheet: (site: SignInSite) => void }) {
  const queryClient = useQueryClient();
  const site = siteOf(record);
  const stale = record.expired || record.refreshAvailable;
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="sign-in-site" data-site={record.site}>
      <Initial text={record.siteName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-text-primary">
          <b className="font-medium">{record.siteName}</b> · {accountLabel(record)}
          {record.expired && <span className="text-warning ml-1.5">expired</span>}
          {!record.expired && record.refreshAvailable && <span className="text-accent ml-1.5">newer sign-in in {record.browserName}</span>}
        </span>
        <span className="truncate text-text-muted" title={`Copies ${record.hosts.join(', ')}`}>
          From {record.browserName} · {record.profileName}
        </span>
      </div>
      {stale && (
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            onSheet(site);
            void signInFlow.refresh(site, record, record.checkUrl);
          }}
        >
          Refresh from {record.browserName}
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        onClick={() => void rpc.rig.pages.signOut({ site: record.site }).then(() => queryClient.invalidateQueries({ queryKey: SIGN_INS_KEY }))}
      >
        Remove
      </Button>
    </div>
  );
}

/** Settings › Sign-ins. */
export function SignInRows() {
  const list = useSignIns();
  const [sheet, setSheet] = useState<SignInSite | null>(null);
  const data = list.data;
  if (!data) return <div data-testid="settings-sign-ins" />;
  const connection = data.connection;
  // Chrome when it's installed, else the first Chromium browser found.
  const browser = connection?.browserName ?? (data.browsers.find((b) => b.id === 'chrome') ?? data.browsers[0])?.name ?? 'Chrome';
  const noBrowser = data.browsers.length === 0;
  return (
    <div className="flex flex-col gap-3" data-testid="settings-sign-ins">
      {data.browsers
        .filter((b) => b.folder === 'denied')
        .map((b) => (
          <AccessWarning key={b.id} browser={b} />
        ))}
      {connection ? (
        <ConnectionRow connection={connection} />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[14px] font-medium text-text-primary">Use your {browser} sign-ins</span>
            {noBrowser ? (
              <p className="text-[12.5px] text-text-muted" data-testid="sign-in-no-browser">
                No Chrome on this Mac, so sign in on the page itself with Sign in here and it stays signed in.
              </p>
            ) : (
              <p className="text-[12.5px] text-text-muted">
                Pages you open beside a chat open signed in as you. Rig copies only the site you open, when you open it.
              </p>
            )}
          </div>
          {!noBrowser && (
            <div>
              <Button size="sm" onClick={() => void connectFlow.start(SETTINGS_WHERE)}>
                Connect {browser}
              </Button>
            </div>
          )}
        </div>
      )}
      <ConnectSheet where={SETTINGS_WHERE} inline />
      {data.sites.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="sign-in-sites">
          <span className="text-xs text-text-muted">Signed in automatically</span>
          {data.sites.map((r) => (
            <SiteRow key={r.site} record={r} onSheet={setSheet} />
          ))}
        </div>
      )}
      {sheet && <SignInSheet siteId={sheet.id} inline onSignInHere={() => setSheet(null)} />}
      {connection && <KeepInStepToggle browser={browser} many />}
      <p className="text-xs text-text-muted">Agents see these pages only as you, only while a turn runs.</p>
    </div>
  );
}
