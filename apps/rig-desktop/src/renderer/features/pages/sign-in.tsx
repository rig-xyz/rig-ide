import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SignInsList } from '@main/rig/pages/page-sign-ins';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import { signInSiteFor, signInSiteForUrl, type PageSignInRecord, type SignInSite } from '@shared/pages/sign-in-sites';
import { signInFlow } from './sign-in-flow';
import { Initial, KeepInStepToggle, SignInSheet } from './sign-in-sheet';
import { accountLabel, browserLabel, macFolderName, SIGN_INS_KEY, useSignIns } from './use-sign-ins';

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

type Browsers = SignInsList['browsers'];

/** "Chrome", "Chrome and Arc", "Chrome, Arc and Brave". */
function names(list: { name: string }[]): string {
  const n = list.map((b) => b.name);
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
}

/** macOS refused rig a browser's data: what to turn on, and the button that goes there. */
function AccessWarning({ browser }: { browser: Browsers[number] }) {
  return (
    <div className="border-warning/40 bg-warning/5 flex items-center gap-3 rounded-control border px-2.5 py-2" data-testid="sign-in-access-denied" data-browser={browser.id}>
      <p className="min-w-0 flex-1 text-xs text-text-primary">
        Rig can't read {browser.name}'s data — turn on {macFolderName(browser.name)} under Privacy & Security › Files & Folders › Rig.
      </p>
      <Button size="xs" variant="outline" onClick={() => void rpc.rig.pages.openPrivacySettings()}>
        Open System Settings
      </Button>
    </div>
  );
}

/** Which browser's sign-in is used, and whether macOS will ask: a footnote, quiet unless something's needed. */
function AccessNote({ browsers }: { browsers: Browsers }) {
  const usable = browsers.filter((b) => b.folder !== 'denied');
  const main = usable[0];
  if (!main) return null;
  const others = usable.slice(1);
  return (
    <p className="text-xs text-text-muted" data-testid="sign-in-access">
      Uses your {main.name} sign-in{others.length > 0 ? ` (${names(others)} also found)` : ''}.
      {main.folder === 'unknown' && ' macOS asks for access the first time.'}
    </p>
  );
}

/** The one action: a button that opens a single field for a site or a link, then the sheet. */
function SignInToSite({ label, primary, onStart }: { label: string; primary: boolean; onStart: (site: SignInSite) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const site = siteFromTyped(typed);
  if (!open)
    return (
      <div>
        <Button size="sm" variant={primary ? 'default' : 'outline'} onClick={() => setOpen(true)}>
          {label}
        </Button>
      </div>
    );
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!site) return;
        setTyped('');
        setOpen(false);
        onStart(site);
      }}
    >
      <input
        autoFocus
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        placeholder="docs.google.com or a link"
        aria-label="Site to sign in to"
        className={cn(
          'border-border-hairline bg-bg-1 h-7 min-w-0 flex-1 rounded-control border px-2 text-xs text-text-primary outline-none',
          'focus-visible:border-border-strong placeholder:text-text-muted'
        )}
      />
      <Button size="xs" type="submit" disabled={!site}>
        Continue
      </Button>
      <Button size="xs" variant="ghost" type="button" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
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
  const data = list.data;
  if (!data) return <div data-testid="settings-sign-ins" />;
  const start = (site: SignInSite) => {
    setSheet(site);
    void signInFlow.start(site);
  };
  const browser = browserLabel(data);
  const hasSites = data.sites.length > 0;
  const noBrowser = data.browsers.length === 0;
  const lead = (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-text-primary">Open pages as you</span>
      {noBrowser ? (
        <p className="text-xs text-text-muted" data-testid="sign-in-no-browser">
          No Chrome on this Mac. Pages can still be signed in by typing into them: open a page beside a chat and sign in on the page
          itself (Sign in here), and it stays signed in.
        </p>
      ) : (
        <p className="text-xs text-text-muted">
          Sign in once, and Google Docs, Notion or any page you open beside a chat opens signed in as you — using your {browser} sign-in for
          just that site.
        </p>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-3" data-testid="settings-sign-ins">
      {data.browsers
        .filter((b) => b.folder === 'denied')
        .map((b) => (
          <AccessWarning key={b.id} browser={b} />
        ))}
      {hasSites ? (
        <div className="flex flex-col gap-2">
          {data.sites.map((r) => (
            <SiteRow key={r.site} record={r} onSheet={setSheet} />
          ))}
        </div>
      ) : (
        lead
      )}
      {sheet && <SignInSheet siteId={sheet.id} inline onSignInHere={() => setSheet(null)} />}
      {!noBrowser && <SignInToSite label={hasSites ? 'Sign in to another site…' : 'Sign in to a site…'} primary={!hasSites} onStart={start} />}
      {hasSites && <KeepInStepToggle browser={browser} many />}
      <AccessNote browsers={data.browsers} />
      <p className="text-xs text-text-muted">Agents see these pages only as you, only while a turn runs.</p>
    </div>
  );
}
