import { Check, KeyRound, Loader2, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import { connectFlow, useConnectFlow, type ConnectFlow } from './connect-flow';
import { Actions, Body, Initial, KeepInStepToggle, Prompt, Title } from './sign-in-sheet';
import { macFolderName, usedAgo } from './use-sign-ins';

/**
 * The "Connect Chrome" sheet (board 18, revised): over a page, or inline in
 * Settings (`inline`). Every step has a way out; closing it keeps nothing.
 */

/** Step 3 closes itself after this long if it isn't touched. */
export const CONNECT_DONE_CLOSE_MS = 5_000;

export function ConnectSheet({ where, inline = false }: { where: string; inline?: boolean }) {
  const flow = useConnectFlow(where);
  useEffect(() => {
    if (!flow || inline) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      connectFlow.close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [flow, inline]);
  if (!flow) return null;
  const card = (
    <div
      role="dialog"
      aria-label="Connect Chrome"
      className={cn('bg-bg-1 border-border-hairline relative flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4', !inline && 'shadow-float')}
      data-testid="connect-sheet"
      data-step={flow.step.kind}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={() => connectFlow.close()}
        className="hover:bg-bg-2 absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-control text-text-muted"
      >
        <X className="size-3.5" strokeWidth={1.5} />
      </button>
      <ConnectStep flow={flow} />
    </div>
  );
  if (inline) return card;
  return <div className="absolute inset-0 z-30 grid place-items-center bg-bg-0/50 p-4">{card}</div>;
}

function browserName(flow: ConnectFlow): string {
  return flow.browsers.find((b) => b.id === flow.browser)?.name ?? 'Chrome';
}

function NotNow() {
  return (
    <Button size="sm" variant="ghost" onClick={() => connectFlow.close()}>
      Not now
    </Button>
  );
}

function ConnectStep({ flow }: { flow: ConnectFlow }) {
  switch (flow.step.kind) {
    case 'heads-up':
      return <HeadsUp flow={flow} />;
    case 'pick':
      return <Pick flow={flow} />;
    case 'connecting':
      return <Connecting flow={flow} />;
    case 'done':
      return <Done flow={flow} />;
    case 'error':
      return <ConnectError flow={flow} />;
  }
}

function HeadsUp({ flow }: { flow: ConnectFlow }) {
  const name = browserName(flow);
  const access = flow.browsers.find((b) => b.id === flow.browser);
  const folder = access?.folder !== 'granted';
  const keychain = access?.keychain !== 'silent';
  const keychainItem = name === 'Edge' ? 'Microsoft Edge' : name;
  return (
    <>
      <Title>Connect {name}</Title>
      <Body>
        Pages you open beside a chat open signed in as you. Rig copies only the site you open, when you open it, from one {name} profile.
      </Body>
      {flow.browsers.length > 1 && (
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Which browser">
          {flow.browsers.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={b.id === flow.browser}
              onClick={() => connectFlow.chooseBrowser(b.id)}
              className={cn(
                'rounded-control border px-2 py-1 text-xs transition-colors',
                b.id === flow.browser ? 'border-accent bg-accent-subtle text-text-primary' : 'border-border-hairline text-text-secondary hover:bg-bg-2'
              )}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}
      {(folder || keychain) && <p className="text-xs text-text-muted">macOS will check with you{folder && keychain ? ', twice' : ''}, once for rig as a whole:</p>}
      {folder && (
        <div className="flex flex-col gap-1" data-testid="heads-up-folder">
          <Prompt icon={<span className="text-xs font-bold">R</span>} text="“Rig” would like to access data from other apps." button="Allow" />
          <p className="text-xs text-text-muted">Choose Allow. If you choose Don't Allow, macOS won't ask again; rig will show you where to turn it on.</p>
        </div>
      )}
      {keychain && (
        <div className="flex flex-col gap-1" data-testid="heads-up-keychain">
          <Prompt icon={<KeyRound className="size-3.5" strokeWidth={1.5} />} text={`Rig wants to use “${keychainItem} Safe Storage”.`} button="Always Allow" />
          <p className="text-xs text-text-muted">Type your Mac password and choose Always Allow, so it won't ask for every site.</p>
        </div>
      )}
      <Actions>
        <Button size="sm" disabled={flow.busy} onClick={() => void connectFlow.next()}>
          {flow.busy ? 'Waiting for macOS…' : 'Continue'}
        </Button>
        <NotNow />
      </Actions>
    </>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-text-muted">{children}</p>;
}

function Pick({ flow }: { flow: ConnectFlow }) {
  const name = browserName(flow);
  return (
    <>
      <Title>Which {name} profile?</Title>
      <div className="flex flex-col gap-1" role="radiogroup" aria-label={`Which ${name} profile`}>
        {(flow.profiles ?? []).map((p) => {
          const on = flow.picked === p.dir;
          return (
            <button
              key={p.dir}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => connectFlow.pick(p.dir)}
              className={cn(
                'flex items-center gap-2 rounded-control border px-2 py-1.5 text-left transition-colors',
                on ? 'border-accent bg-accent-subtle' : 'border-border-hairline hover:bg-bg-2'
              )}
              data-testid="connect-profile"
            >
              <Initial text={p.email ?? p.name} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs font-medium text-text-primary">{p.name}</span>
                <span className="truncate text-xs text-text-muted">
                  {p.email ?? 'No account'}
                  {p.lastActiveAt ? ` · used ${usedAgo(p.lastActiveAt)}` : ''}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <Actions>
        <Button size="sm" onClick={() => void connectFlow.next()}>
          Connect
        </Button>
        <NotNow />
      </Actions>
    </>
  );
}

function Connecting({ flow }: { flow: ConnectFlow }) {
  return (
    <>
      <Title>Connecting {browserName(flow)}…</Title>
      <p className="flex items-center gap-1.5 text-xs text-text-secondary">
        <Loader2 className="size-3 animate-spin text-text-muted" /> Waiting for macOS: type your Mac password and choose Always Allow.
      </p>
      <Actions>
        <Button size="sm" variant="outline" onClick={() => connectFlow.close()}>
          Cancel
        </Button>
      </Actions>
    </>
  );
}

function Done({ flow }: { flow: ConnectFlow }) {
  const touched = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!touched.current) connectFlow.close();
    }, CONNECT_DONE_CLOSE_MS);
    return () => clearTimeout(timer);
  }, []);
  if (flow.step.kind !== 'done') return null;
  const c = flow.step.connection;
  return (
    <div className="flex flex-col gap-3" onPointerDown={() => (touched.current = true)} onFocus={() => (touched.current = true)}>
      <Title>
        <span className="flex items-center gap-1.5">
          <Check className="text-success size-4" strokeWidth={2} />
          {c.browserName} connected
        </span>
      </Title>
      <Body>
        Pages you open beside a chat now sign in as {c.email ?? c.profileName}, from {c.browserName} · {c.profileName}.
      </Body>
      <KeepInStepToggle browser={c.browserName} />
      <Actions>
        <Button size="sm" onClick={() => connectFlow.close()}>
          Done
        </Button>
      </Actions>
    </div>
  );
}

function ConnectError({ flow }: { flow: ConnectFlow }) {
  if (flow.step.kind !== 'error') return null;
  const name = browserName(flow);
  const tryAgain = (
    <Button size="sm" disabled={flow.busy} onClick={() => void connectFlow.retry()}>
      Try again
    </Button>
  );
  const body = (title: string, text: ReactNode, actions: ReactNode) => (
    <div className="flex flex-col gap-3" data-testid="connect-error" data-reason={flow.step.kind === 'error' ? flow.step.reason : ''}>
      <Title>{title}</Title>
      <Hint>{text}</Hint>
      <Actions>{actions}</Actions>
    </div>
  );
  switch (flow.step.reason) {
    case 'folder_access_denied':
      return body(
        `Rig can't read ${name}'s data yet`,
        `Turn on ${macFolderName(name)} under System Settings › Privacy & Security › Files & Folders › Rig. Rig tries again when you come back.`,
        <>
          <Button size="sm" onClick={() => void rpc.rig.pages.openPrivacySettings()}>
            Open System Settings
          </Button>
          <NotNow />
        </>
      );
    case 'keychain_denied':
      return body(`macOS didn't hand over ${name}'s key`, 'Try again and choose Always Allow.', <>{tryAgain}<NotNow /></>);
    case 'no_profiles':
      return body(`${name} has no profiles yet`, `Open ${name} once and sign in to the sites you use, then try again.`, <>{tryAgain}<NotNow /></>);
    case 'no_browser':
      return body('No Chrome on this Mac', 'Pages can still be signed in by typing into them.', <NotNow />);
    default:
      return body(`Couldn't connect ${name}`, 'Nothing was copied. Try again.', <>{tryAgain}<NotNow /></>);
  }
}
