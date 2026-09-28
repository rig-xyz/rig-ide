import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SignInsList } from '@main/rig/pages/page-sign-ins';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import { signInSiteFor, signInSiteForUrl, type PageSignInRecord, type SignInSite } from '@shared/pages/sign-in-sites';
import { signInFlow } from './sign-in-flow';
import { Initial, KeepInStepToggle, SignInSheet } from './sign-in-sheet';
import { accountLabel, browserLabel, SIGN_INS_KEY, useSignIns } from './use-sign-ins';

/**
 * Settings › Sign-ins (canvas board 18, E): any site you've signed in, where
 * each came from, and the one macOS permission. Per site, like Claude's
 * own browser: approved once, in context, with the hosts copied in view.
 * Switch, Refresh and Add a site run the same sheet as a page, inline.
 */

/** A typed site ("notion.so", or a link) as a site, or null. */
export function siteFromTyped(typed: string): SignInSite | null {
  const text = typed.trim();
  if (!text) return null;
  return signInSiteForUrl(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
}

function siteOf(record: PageSignInRecord): SignInSite {
  return { ...signInSiteFor(record.site), name: record.siteName, hosts: record.hosts, checkUrl: record.checkUrl };
}

function BrowserAccessRow({ browser }: { browser: SignInsList['browsers'][number] }) {
  return (
    <div className="flex flex-col gap-1" data-testid="sign-in-access" data-folder={browser.folder}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-text-primary">{browser.name}</span>
        <span className="min-w-0 flex-1 truncate text-text-muted">Rig can read one site's sign-in at a time from your {browser.name} profiles</span>
        {browser.folder === 'granted' ? (
          <span className="text-success shrink-0">Allowed</span>
        ) : browser.folder === 'denied' ? (
          <span className="text-warning shrink-0">Not allowed</span>
        ) : (
          <span className="shrink-0 text-text-muted">Asks the first time</span>
        )}
      </div>
      {browser.folder === 'denied' && (
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => void rpc.rig.pages.openPrivacySettings()}>
            Open System Settings
          </Button>
          <span className="text-xs text-text-muted">Signed-in sites keep working; only new or refreshed sign-ins need it.</span>
        </div>
      )}
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
        <span className="truncate text-text-muted">
          {record.browserName} · {record.profileName} · {record.hosts.join(', ')}
        </span>
      </div>
      {stale ? (
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
      ) : (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            onSheet(site);
            void signInFlow.start(site, record.checkUrl, { switching: true });
          }}
        >
          Switch
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
  const [typed, setTyped] = useState('');
  const data = list.data;
  const typedSite = siteFromTyped(typed);
  const add = () => {
    if (!typedSite) return;
    setSheet(typedSite);
    setTyped('');
    void signInFlow.start(typedSite);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="settings-sign-ins">
      {data && data.browsers.length === 0 && (
        <p className="text-xs text-text-muted" data-testid="sign-in-no-browser">
          No Chrome on this Mac. Pages can still be signed in by typing into them.
        </p>
      )}
      {data?.browsers.map((b) => (
        <BrowserAccessRow key={b.id} browser={b} />
      ))}
      {(data?.sites.length ?? 0) > 0 && (
        <div className="border-border-hairline flex flex-col gap-2 border-t pt-3">
          {data!.sites.map((r) => (
            <SiteRow key={r.site} record={r} onSheet={setSheet} />
          ))}
        </div>
      )}
      {sheet && <SignInSheet siteId={sheet.id} inline onSignInHere={() => setSheet(null)} />}
      {(data?.sites.length ?? 0) > 0 && <KeepInStepToggle browser={browserLabel(data)} many />}
      {(data?.browsers.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="Add a site: notion.so"
              aria-label="Add a site"
              className={cn(
                'border-border-hairline bg-bg-1 h-7 min-w-0 flex-1 rounded-control border px-2 text-xs text-text-primary outline-none',
                'focus-visible:border-border-strong placeholder:text-text-muted'
              )}
            />
            <Button size="xs" variant="outline" type="submit" disabled={!typedSite}>
              Add a site
            </Button>
          </form>
          <p className="text-xs text-text-muted">Type a site, or it's added the first time you sign a page in.</p>
        </div>
      )}
      <p className="text-xs text-text-muted">
        Pages open as you. Agents see them only as you, only while a turn runs. Rig never copies a whole profile.
      </p>
    </div>
  );
}
