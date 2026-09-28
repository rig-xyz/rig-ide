import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, ExternalLink, Globe, KeyRound, LogOut, PenLine, RefreshCw, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverMenuItem, PopoverSeparator } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import type { SignInSite } from '@shared/pages/sign-in-sites';
import { isUnfinished, signInFlow, useSignInFlow } from './sign-in-flow';
import { Initial } from './sign-in-sheet';
import { accountLabel, browserLabel, recordFor, SIGN_INS_KEY, useSignIns } from './use-sign-ins';

/**
 * The account chip in a page's header (canvas board 18, A): every page says
 * who it's open as. The page always loads; signing in is offered, never
 * required. The menu always has a way in: the browser's sign-in, signing
 * in on the page itself, or the page in the browser.
 */
export function AccountChip({ site, pageUrl, onSignInHere }: { site: SignInSite; pageUrl: string; onSignInHere: () => void }) {
  const queryClient = useQueryClient();
  const list = useSignIns();
  const flow = useSignInFlow(site.id);
  const record = recordFor(list.data, site.id);
  const browser = browserLabel(list.data, record?.browser);
  const hasBrowser = (list.data?.browsers.length ?? 0) > 0;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const act = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const openInBrowser = () => void rpc.rig.pages.openInBrowser({ url: pageUrl });
  const signOut = () => void rpc.rig.pages.signOut({ site: site.id }).then(() => queryClient.invalidateQueries({ queryKey: SIGN_INS_KEY }));

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

  const signedIn = record && !record.expired;
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
          signedIn ? 'border-border-hairline' : 'border-border-strong border-dashed'
        )}
        data-testid="account-chip"
        data-state={signedIn ? 'signed-in' : record ? 'expired' : 'signed-out'}
      >
        {signedIn ? (
          <>
            <Initial text={accountLabel(record)} className="size-4" />
            <span className="truncate">{accountLabel(record)}</span>
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
            <PopoverMenuItem icon={PenLine} label="Sign in here" onSelect={act(onSignInHere)} />
            <PopoverMenuItem icon={ExternalLink} label={`Open in ${browser}`} onSelect={act(openInBrowser)} />
            <PopoverSeparator />
            <PopoverMenuItem icon={LogOut} label={`Sign out of ${site.name} in rig`} onSelect={act(signOut)} />
          </>
        ) : (
          <>
            {hasBrowser && (
              <PopoverMenuItem icon={KeyRound} label={`Use ${browser} sign-in for ${site.name}`} onSelect={act(() => void signInFlow.start(site, pageUrl))} />
            )}
            <PopoverMenuItem icon={PenLine} label="Sign in here" onSelect={act(onSignInHere)} />
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
export function SignInBanner({ site, pageUrl, wall, dismissed, onDismiss }: { site: SignInSite; pageUrl: string; wall: boolean; dismissed: boolean; onDismiss: () => void }) {
  const list = useSignIns();
  const flow = useSignInFlow(site.id);
  const record = recordFor(list.data, site.id);
  const browser = browserLabel(list.data, record?.browser);
  if (!wall || dismissed || flow?.open || !list.data || list.data.browsers.length === 0) return null;
  if (record && !record.expired) return null;
  const unfinished = isUnfinished(flow);
  return (
    <div className="border-border-hairline bg-bg-1 flex shrink-0 items-center gap-2.5 border-b px-4 py-1.5 text-xs" data-testid="sign-in-banner">
      <span className="min-w-0 flex-1 text-text-secondary">
        {record
          ? `Your ${site.name} sign-in in rig has expired.`
          : `This page wants you signed in. Use your ${browser} sign-in for ${site.name}?`}
      </span>
      {record ? (
        <Button size="xs" onClick={() => void signInFlow.refresh(site, record, pageUrl)}>
          Refresh from {browser}
        </Button>
      ) : (
        <Button size="xs" onClick={() => void signInFlow.start(site, pageUrl)}>
          {unfinished ? 'Finish signing in' : `Use ${browser} sign-in`}
        </Button>
      )}
      <button type="button" aria-label="Hide for this page" onClick={onDismiss} className="hover:bg-bg-2 grid size-5 place-items-center rounded-control text-text-muted">
        <X className="size-3" strokeWidth={1.5} />
      </button>
    </div>
  );
}
