import { useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import { signInFlow, useSignInFlow, type SignInFlow } from './sign-in-flow';
import { accountLabel, browserLabel, macFolderName, SIGN_INS_KEY, useSignIns, usedAgo } from './use-sign-ins';

/**
 * The sheet (canvas board 18, B): a card over the page, not a new screen.
 * Every step has a way out, and closing it at any step leaves the page
 * usable, signed out, with the chip ready to pick up where it was left.
 * `inline` is the same sheet inside Settings › Sign-ins.
 */

/** After this long checking, the Keychain prompt was probably missed or ignored (case 3). */
export const MACOS_WAIT_MS = 60_000;
/** Step 4 closes itself after this long if it isn't touched. */
export const DONE_CLOSE_MS = 6_000;

export function SignInSheet({ siteId, inline = false, onSignInHere }: { siteId: string; inline?: boolean; onSignInHere?: () => void }) {
  const flow = useSignInFlow(siteId);
  useEffect(() => {
    if (!flow?.open || inline) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      signInFlow.close(siteId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [flow?.open, inline, siteId]);
  if (!flow?.open) return null;
  const here = () => {
    signInFlow.hereInstead(siteId);
    onSignInHere?.();
  };
  const card = (
    <div
      role="dialog"
      aria-label={`Sign in to ${flow.site.name}`}
      className={cn('bg-bg-1 border-border-hairline relative flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4', !inline && 'shadow-float')}
      data-testid="sign-in-sheet"
      data-step={flow.step.kind}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={() => signInFlow.close(siteId)}
        className="hover:bg-bg-2 absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-control text-text-muted"
      >
        <X className="size-3.5" strokeWidth={1.5} />
      </button>
      <Step flow={flow} onSignInHere={here} />
    </div>
  );
  if (inline) return card;
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-bg-0/50 p-4" data-testid="sign-in-sheet-backdrop">
      {card}
    </div>
  );
}

function Title({ children }: { children: ReactNode }) {
  return <p className="pr-6 text-sm font-medium text-text-primary">{children}</p>;
}

function Body({ children }: { children: ReactNode }) {
  return <p className="text-xs text-text-secondary">{children}</p>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-1.5 pt-1">{children}</div>;
}

function Step({ flow, onSignInHere }: { flow: SignInFlow; onSignInHere: () => void }) {
  const id = flow.site.id;
  const browser = browserLabel(flow, flow.picked?.browser);
  const notNow = (
    <Button size="sm" variant="ghost" onClick={() => signInFlow.close(id)}>
      Not now
    </Button>
  );
  switch (flow.step.kind) {
    case 'share':
      return <ShareStep flow={flow} browser={browser} notNow={notNow} />;
    case 'heads-up':
      return <HeadsUpStep flow={flow} browser={browser} notNow={notNow} />;
    case 'verifying':
      return <VerifyingStep flow={flow} browser={browser} since={flow.step.since} onSignInHere={onSignInHere} />;
    case 'done':
      return <DoneStep flow={flow} browser={browser} />;
    case 'error':
      return <ErrorStep flow={flow} browser={browser} onSignInHere={onSignInHere} notNow={notNow} />;
  }
}

function ShareStep({ flow, browser, notNow }: { flow: SignInFlow; browser: string; notNow: ReactNode }) {
  const id = flow.site.id;
  const profiles = flow.options?.profiles ?? [];
  const manyBrowsers = new Set(profiles.map((p) => p.browser)).size > 1;
  const choose = profiles.length > 1 || (flow.switching && profiles.length > 0);
  const only = profiles.length === 1 && !flow.switching ? profiles[0] : undefined;
  return (
    <>
      <Title>{flow.switching ? `Switch the ${flow.site.name} account` : `Use your ${browser} sign-in for ${flow.site.name}?`}</Title>
      <Body>Rig copies only these sites' sign-in into its own pages:</Body>
      <div className="flex flex-wrap gap-1" data-testid="sign-in-hosts">
        {flow.site.hosts.map((h) => (
          <span key={h} className="bg-bg-2 rounded-control px-1.5 py-0.5 font-mono text-xs text-text-secondary">
            {h}
          </span>
        ))}
      </div>
      {flow.busy && !flow.options && (
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <Loader2 className="size-3 animate-spin" /> Looking at your {browser} profiles…
        </p>
      )}
      {choose && (
        <div className="flex flex-col gap-1" role="radiogroup" aria-label={`From which ${browser} profile?`}>
          <p className="text-xs text-text-muted">From which {browser} profile?</p>
          {profiles.map((p) => {
            const on = flow.picked?.browser === p.browser && flow.picked.profile === p.dir;
            return (
              <button
                key={`${p.browser}/${p.dir}`}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => signInFlow.pick(id, p.browser, p.dir)}
                className={cn(
                  'flex items-center gap-2 rounded-control border px-2 py-1.5 text-left transition-colors',
                  on ? 'border-accent bg-accent-subtle' : 'border-border-hairline hover:bg-bg-2'
                )}
                data-testid="sign-in-profile"
              >
                <Initial text={p.email ?? p.name} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-medium text-text-primary">
                    {manyBrowsers ? `${p.browserName} · ` : ''}
                    {p.name}
                  </span>
                  <span className="truncate text-xs text-text-muted">
                    {p.email ? `${p.email} · ` : ''}used {usedAgo(p.lastUsedAt)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {only && (
        <p className="text-xs text-text-muted" data-testid="sign-in-only-profile">
          From {only.browserName} · {only.name}
          {only.email ? ` (${only.email})` : ''}
        </p>
      )}
      <Actions>
        <Button size="sm" disabled={flow.busy} onClick={() => void signInFlow.next(id)}>
          Continue
        </Button>
        {notNow}
      </Actions>
    </>
  );
}

function HeadsUpStep({ flow, browser, notNow }: { flow: SignInFlow; browser: string; notNow: ReactNode }) {
  const id = flow.site.id;
  const access = flow.browsers.find((b) => b.id === flow.picked?.browser) ?? flow.browsers[0];
  const folder = access?.folder !== 'granted';
  const keychain = access?.keychain !== 'silent';
  // The Keychain item's name: "Chrome Safe Storage", "Microsoft Edge Safe Storage", …
  const vendor = browser === 'Edge' ? 'Microsoft Edge' : browser;
  return (
    <>
      <Title>macOS will check with you{folder && keychain ? ', twice' : ''}</Title>
      <Body>Once for rig as a whole, not per site.</Body>
      {folder && (
        <div className="flex flex-col gap-1" data-testid="heads-up-folder">
          <Prompt icon={<span className="text-xs font-bold">R</span>} text="“Rig” would like to access data from other apps." button="Allow" />
          <p className="text-xs text-text-muted">
            Choose <b className="font-medium text-text-primary">Allow</b>. If you choose Don't Allow, macOS won't ask again; rig will show you where to turn it on.
          </p>
        </div>
      )}
      {keychain && (
        <div className="flex flex-col gap-1" data-testid="heads-up-keychain">
          <Prompt icon={<KeyRound className="size-3.5" strokeWidth={1.5} />} text={`Rig wants to use “${vendor} Safe Storage”.`} button="Always Allow" />
          <p className="text-xs text-text-muted">
            Type your Mac password and choose <b className="font-medium text-text-primary">Always Allow</b>, so it won't ask for every site.
          </p>
        </div>
      )}
      <Actions>
        <Button size="sm" disabled={flow.busy} onClick={() => void signInFlow.next(id)}>
          {flow.busy ? 'Waiting for macOS…' : 'Continue'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => signInFlow.back(id)}>
          Back
        </Button>
        {notNow}
      </Actions>
    </>
  );
}

function Prompt({ icon, text, button }: { icon: ReactNode; text: string; button: string }) {
  return (
    <div className="bg-bg-2 flex items-center gap-2 rounded-control px-2 py-1.5">
      <span className="bg-bg-3 grid size-6 shrink-0 place-items-center rounded-control text-text-secondary">{icon}</span>
      <span className="min-w-0 flex-1 text-xs text-text-primary">{text}</span>
      <span className="border-border-strong shrink-0 rounded-control border px-1.5 py-0.5 text-xs text-text-primary">{button}</span>
    </div>
  );
}

function VerifyingStep({ flow, browser, since, onSignInHere }: { flow: SignInFlow; browser: string; since: number; onSignInHere: () => void }) {
  const id = flow.site.id;
  const [elapsed, setElapsed] = useState(() => Date.now() - since);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - since), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const stuck = elapsed >= MACOS_WAIT_MS;
  return (
    <>
      <Title>Signing you in…</Title>
      <ul className="flex flex-col gap-1.5 text-xs text-text-secondary">
        <li className="flex items-center gap-2">
          <Loader2 className="size-3 animate-spin text-text-muted" />
          Read {browser}'s sign-in for {flow.site.name}
          {elapsed > 2_000 && !stuck && <span className="text-text-muted">· Waiting for macOS…</span>}
        </li>
        <li className="flex items-center gap-2 pl-5">Copied into rig's pages</li>
        <li className="flex items-center gap-2 pl-5">Reloading the page to check {flow.site.name} accepts it</li>
      </ul>
      {stuck && (
        <p className="text-xs text-text-muted" data-testid="sign-in-stuck">
          macOS hasn't answered. Its prompt may be behind another window.
        </p>
      )}
      <Actions>
        {stuck && (
          <Button
            size="sm"
            onClick={() => {
              signInFlow.cancel(id);
              void signInFlow.start(flow.site, flow.pageUrl).then(() => signInFlow.next(id));
            }}
          >
            Try again
          </Button>
        )}
        <Button size="sm" variant={stuck ? 'ghost' : 'outline'} onClick={() => signInFlow.cancel(id)}>
          Cancel
        </Button>
        {stuck && (
          <Button size="sm" variant="ghost" onClick={onSignInHere}>
            Sign in here
          </Button>
        )}
      </Actions>
    </>
  );
}

function DoneStep({ flow, browser }: { flow: SignInFlow; browser: string }) {
  const id = flow.site.id;
  const record = flow.step.kind === 'done' ? flow.step.record : null;
  const touched = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!touched.current) signInFlow.close(id);
    }, DONE_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [id]);
  return (
    <div className="flex flex-col gap-3" onPointerDown={() => (touched.current = true)} onFocus={() => (touched.current = true)}>
      <Title>
        <span className="flex items-center gap-1.5">
          <Check className="text-success size-4" strokeWidth={2} />
          You're in as {record ? accountLabel(record) : 'you'}
        </span>
      </Title>
      <Body>
        {flow.site.name} pages beside the chat now open as you. You'll find it under Settings › Sign-ins.
      </Body>
      <KeepInStepToggle browser={browser} />
      <Actions>
        <Button size="sm" onClick={() => signInFlow.close(id)}>
          Done
        </Button>
      </Actions>
    </div>
  );
}

export function KeepInStepToggle({ browser, many = false }: { browser: string; many?: boolean }) {
  const queryClient = useQueryClient();
  const list = useSignIns();
  const on = list.data?.keepInStep ?? false;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-medium text-text-primary">Keep in step with {browser}</span>
        <span className="text-xs text-text-muted">
          {many
            ? `When you come back to rig, pick up newer sign-ins for these sites. Never adds a site you didn't pick.`
            : `When you come back to rig, pick up a newer sign-in from ${browser}`}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Keep in step with ${browser}`}
        onClick={() => void rpc.rig.pages.setKeepInStep({ on: !on }).then(() => queryClient.invalidateQueries({ queryKey: SIGN_INS_KEY }))}
        className={cn('relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-bg-2 border-border-hairline border')}
        data-testid="keep-in-step"
      >
        <span className={cn('absolute top-0.5 size-3 rounded-full bg-text-primary transition-[left]', on ? 'left-3.5' : 'left-0.5')} />
      </button>
    </div>
  );
}

function ErrorStep({ flow, browser, onSignInHere, notNow }: { flow: SignInFlow; browser: string; onSignInHere: () => void; notNow: ReactNode }) {
  const id = flow.site.id;
  if (flow.step.kind !== 'error') return null;
  const { reason, watching } = flow.step;
  const errorBrowser = browserLabel(flow, flow.step.browser);
  const here = (primary = false) => (
    <Button size="sm" variant={primary ? 'default' : 'ghost'} onClick={onSignInHere}>
      Sign in here
    </Button>
  );
  const tryAgain = (primary = true) => (
    <Button size="sm" variant={primary ? 'default' : 'ghost'} disabled={flow.busy} onClick={() => void signInFlow.retry(id)}>
      Try again
    </Button>
  );
  const body = (title: string, text: ReactNode, actions: ReactNode) => (
    <div className="flex flex-col gap-3" data-testid="sign-in-error" data-reason={reason}>
      <Title>{title}</Title>
      <Body>{text}</Body>
      <Actions>{actions}</Actions>
    </div>
  );
  switch (reason) {
    case 'folder_access_denied':
      return body(
        `Rig can't read ${errorBrowser}'s data yet`,
        <>
          macOS was told not to let rig in. Turn it on in System Settings › Privacy & Security › Files & Folders › Rig ›{' '}
          {macFolderName(errorBrowser)}. Rig tries again when you come back.
        </>,
        <>
          <Button size="sm" onClick={() => void rpc.rig.pages.openPrivacySettings()}>
            Open System Settings
          </Button>
          {here()}
          {notNow}
        </>
      );
    case 'keychain_denied':
      return body(
        `macOS didn't hand over ${errorBrowser}'s key`,
        'Try again and choose Always Allow.',
        <>
          {tryAgain()}
          {here()}
          {notNow}
        </>
      );
    case 'not_signed_in':
      return body(
        `Sign in to ${flow.site.name} in ${browser} first`,
        watching === 'checking'
          ? `Checking ${browser} again…`
          : watching === 'waiting'
            ? `Sign in there, then come back: rig checks again. ${browser} can take up to half a minute to save a new sign-in.`
            : watching === 'gave-up'
              ? `Still no ${flow.site.name} sign-in in ${browser}. It can take a moment to save one; check again in a bit.`
              : `No ${browser} profile is signed in to ${flow.site.name}. Rig opens the page in ${browser} and checks again when you come back.`,
        <>
          {watching === 'gave-up' ? (
            tryAgain()
          ) : (
            <Button size="sm" disabled={watching === 'checking'} onClick={() => void signInFlow.openInChrome(id)}>
              Open in {browser}
            </Button>
          )}
          {here()}
          <Button size="sm" variant="ghost" onClick={() => signInFlow.hereInstead(id)}>
            Cancel
          </Button>
        </>
      );
    case 'rejected_by_site':
      return body(
        `${flow.site.name} didn't accept your ${browser} sign-in in rig`,
        "Sign in here instead; it'll stay signed in.",
        <>
          {here(true)}
          <Button size="sm" variant="ghost" onClick={() => void rpc.rig.pages.openInBrowser({ url: flow.pageUrl ?? flow.site.checkUrl })}>
            Open in {browser}
          </Button>
          {tryAgain(false)}
        </>
      );
    case 'no_browser':
      return body(
        'No Chrome on this Mac',
        'Sign in by typing into the page instead, or open it in your browser.',
        <>
          {here(true)}
          <Button size="sm" variant="ghost" onClick={() => void rpc.rig.pages.openInBrowser({ url: flow.pageUrl ?? flow.site.checkUrl })}>
            Open in browser
          </Button>
        </>
      );
    default:
      return body(
        `Something went wrong reading your ${browser} sign-in`,
        'Nothing was copied. Try again, or sign in here.',
        <>
          {tryAgain()}
          {here()}
          {notNow}
        </>
      );
  }
}

export function Initial({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('bg-accent-subtle text-accent grid size-5 shrink-0 place-items-center rounded-full text-xs font-semibold uppercase', className)}>
      {text.slice(0, 1)}
    </span>
  );
}
