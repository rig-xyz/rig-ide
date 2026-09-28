import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, ExternalLink, Globe, KeyRound, Loader2, LogOut, PenLine, RefreshCw, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverMenuItem, PopoverSeparator } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import type { SignInSite } from '@shared/pages/sign-in-sites';
import { clearAutoSignIn, openInChromeAndWatch, runAutoSignIn, useAutoSignIn } from './auto-sign-in';
import { connectFlow, useConnectFlow } from './connect-flow';
import { isUnfinished, signInFlow, useSignInFlow } from './sign-in-flow';
import { Initial } from './sign-in-sheet';
import { accountLabel, browserLabel, recordFor, SIGN_INS_KEY, useSignIns } from './use-sign-ins';

/**
 * The account chip in a page's header (canvas board 18, A): every page says
 * who it's open as. The page always loads; signing in is offered, never
 * required. The menu always has a way in: the browser's sign-in, signing
 * in on the page itself, or the page in the browser.
 */
export function AccountChip({
  site,
  pageUrl,
  where,
  onSignInHere,
  notShared = false,
}: {
  site: SignInSite;
  pageUrl: string;
  /** The page's key for the Connect sheet (so it opens over this page). */
  where: string;
  onSignInHere: () => void;
  /** Signed in, but the site says this account can't see the page (case 8). */
  notShared?: boolean;
}) {
  const queryClient = useQueryClient();
  const list = useSignIns();
  const flow = useSignInFlow(site.id);
  const auto = useAutoSignIn(site.id);
  const record = recordFor(list.data, site.id);
  const connection = list.data?.connection ?? null;
  const browser = connection?.browserName ?? browserLabel(list.data, record?.browser);
  const hasBrowser = (list.data?.browsers.length ?? 0) > 0;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const act = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const openInBrowser = () => void rpc.rig.pages.openInBrowser({ url: pageUrl });
  const signOut = () => void rpc.rig.pages.signOut({ site: site.id }).then(() => queryClient.invalidateQueries({ queryKey: SIGN_INS_KEY }));
  const here = () => {
    clearAutoSignIn(site.id);
    onSignInHere();
  };
  const signedIn = record && !record.expired;

  if (!signedIn && auto?.phase === 'signing') {
    return (
      <span className="flex h-6 items-center gap-1.5 rounded-full px-2 text-xs text-text-muted" data-testid="account-chip" data-state="signing">
        <Loader2 className="size-3 animate-spin" />
        Signing in with {browser}…
      </span>
    );
  }
  if (!signedIn && auto?.phase === 'failed' && auto.reason !== 'not_signed_in_in_browser' && !flow?.open) {
    // Folder access, the Keychain, or the site refusing: the sheet's clear error states, with their actions.
    return (
      <button
        type="button"
        onClick={() => signInFlow.showError(site, pageUrl, auto.reason, connection, auto.browser)}
        className="border-warning/50 text-warning hover:bg-bg-2 flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs transition-colors"
        data-testid="account-chip"
        data-state="failed"
      >
        Couldn't sign in
      </button>
    );
  }

  if (isUnfinished(flow)) {
    return (
      <button
        type="button"
        onClick={() => void signInFlow.start(site, pageUrl)}
        className="border-accent text-accent hover:bg-accent-subtle flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs transition-colors"
        data-testid="account-chip"
        data-state="unfinished"
      >
        <KeyRound className="size-3" strokeWidth={1.5} />
        Finish signing in
      </button>
    );
  }

  const notInChrome = auto?.phase === 'failed' && auto.reason === 'not_signed_in_in_browser' ? auto : null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'hover:bg-bg-2 flex h-6 max-w-56 items-center gap-1.5 rounded-full border px-2 text-xs text-text-secondary transition-colors',
          signedIn ? (notShared ? 'border-warning/50' : 'border-border-hairline') : 'border-border-strong border-dashed'
        )}
        data-testid="account-chip"
        data-state={signedIn ? (notShared ? 'not-shared' : 'signed-in') : record ? 'expired' : 'signed-out'}
      >
        {signedIn ? (
          <>
            <Initial text={accountLabel(record)} className="size-4" />
            <span className="truncate">{accountLabel(record)}</span>
            {notShared && <span className="text-warning shrink-0">· no access</span>}
            {record.refreshAvailable && <span className="bg-accent size-1.5 shrink-0 rounded-full" aria-label="A newer sign-in is available" />}
          </>
        ) : (
          <span className="truncate">{record ? 'Signed out' : 'Not signed in'}</span>
        )}
      </button>
      <Popover anchor={triggerRef} open={open} onClose={() => setOpen(false)} align="right" minWidth={240} ariaLabel="Sign-in">
        {signedIn ? (
          <>
            <p className="px-2.5 pt-1 pb-1.5 text-xs text-text-muted">
              From {record.browserName} · {record.profileName}
            </p>
            <PopoverMenuItem icon={ArrowRightLeft} label="Switch account…" onSelect={act(() => void signInFlow.start(site, pageUrl, { switching: true }))} />
            <PopoverMenuItem
              icon={RefreshCw}
              label={`Refresh from ${browser}`}
              onSelect={act(() => void signInFlow.refresh(site, record, pageUrl))}
            />
            <PopoverSeparator />
            <PopoverMenuItem icon={LogOut} label={`Sign out of ${site.name} in rig`} onSelect={act(signOut)} />
          </>
        ) : record ? (
          <>
            <p className="px-2.5 pt-1 pb-1.5 text-xs text-text-muted">
              Rig's {site.name} sign-in has expired or was refused.
            </p>
            <PopoverMenuItem icon={RefreshCw} label={`Refresh from ${browser}`} onSelect={act(() => void signInFlow.refresh(site, record, pageUrl))} />
            <PopoverMenuItem icon={PenLine} label="Sign in here" onSelect={act(here)} />
            <PopoverMenuItem icon={ExternalLink} label={`Open in ${browser}`} onSelect={act(openInBrowser)} />
            <PopoverSeparator />
            <PopoverMenuItem icon={LogOut} label={`Sign out of ${site.name} in rig`} onSelect={act(signOut)} />
          </>
        ) : notInChrome ? (
          <>
            <p className="px-2.5 pt-1 pb-1.5 text-xs text-text-muted" data-testid="not-in-chrome">
              {notInChrome.watching === 'checking'
                ? `Checking ${browser} again…`
                : notInChrome.watching === 'waiting'
                  ? `Sign in there, then come back: rig picks it up.`
                  : notInChrome.watching === 'gave-up'
                    ? `Still no ${site.name} sign-in in ${browser}. Open it there, then come back.`
                    : `${browser}${connection ? ` · ${connection.profileName}` : ''} isn't signed in to ${site.name}.`}
            </p>
            <PopoverMenuItem icon={ExternalLink} label={`Open in ${browser}`} onSelect={act(() => void openInChromeAndWatch(site.id, pageUrl, connection?.browser))} />
            <PopoverMenuItem icon={PenLine} label="Sign in here" onSelect={act(here)} />
          </>
        ) : (
          <>
            {hasBrowser && !connection && (
              <PopoverMenuItem
                icon={KeyRound}
                label={`Connect ${browser}…`}
                onSelect={act(() => void connectFlow.start(where, () => void runAutoSignIn(site.id, { retry: true })))}
              />
            )}
            {connection && (
              <PopoverMenuItem icon={KeyRound} label={`Sign in with ${browser}`} onSelect={act(() => void runAutoSignIn(site.id, { retry: true }))} />
            )}
            <PopoverMenuItem icon={PenLine} label="Sign in here" onSelect={act(here)} />
            <PopoverMenuItem icon={hasBrowser ? ExternalLink : Globe} label={hasBrowser ? `Open in ${browser}` : 'Open in browser'} onSelect={act(openInBrowser)} />
          </>
        )}
        <p className="border-border-hairline mt-1 border-t px-2.5 pt-1.5 pb-1 text-xs text-text-muted">
          Pages open as you. Agents see them only as you, only while a turn runs.
        </p>
      </Popover>
    </>
  );
}

/**
 * The sign-in-wall banner (board 18, A): shown when the page lands on a
 * sign-in form and rig could sign it in. ✕ hides it for this page; the chip
 * keeps the option.
 */
export function SignInBanner({
  site,
  pageUrl,
  where,
  wall,
  dismissed,
  onDismiss,
}: {
  site: SignInSite;
  pageUrl: string;
  where: string;
  wall: boolean;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  const list = useSignIns();
  const flow = useSignInFlow(site.id);
  const connecting = useConnectFlow(where);
  const record = recordFor(list.data, site.id);
  if (!wall || dismissed || flow?.open || connecting || !list.data || list.data.browsers.length === 0) return null;
  if (record && !record.expired) return null;
  const connection = list.data.connection;
  const browser = connection?.browserName ?? browserLabel(list.data, record?.browser);
  // Connected and never signed in: the automatic sign-in and the chip handle it.
  if (connection && !record) return null;
  return (
    <div className="border-border-hairline bg-bg-1 flex shrink-0 items-center gap-2.5 border-b px-4 py-1.5 text-xs" data-testid="sign-in-banner">
      <span className="min-w-0 flex-1 text-text-secondary">
        {record ? `Your ${site.name} sign-in in rig has expired.` : `Connect ${browser} to open pages as you.`}
      </span>
      {record ? (
        <Button size="xs" onClick={() => void signInFlow.refresh(site, record, pageUrl)}>
          Refresh from {browser}
        </Button>
      ) : (
        <Button size="xs" onClick={() => void connectFlow.start(where, () => void runAutoSignIn(site.id, { retry: true }))}>
          Connect
        </Button>
      )}
      <button type="button" aria-label="Hide for this page" onClick={onDismiss} className="hover:bg-bg-2 grid size-5 place-items-center rounded-control text-text-muted">
        <X className="size-3" strokeWidth={1.5} />
      </button>
    </div>
  );
}
