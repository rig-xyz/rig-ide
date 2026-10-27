import { Check, Copy, Download, Loader2, LogIn, Play, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { useClipboard } from '@renderer/lib/hooks/use-clipboard';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import type { AgentInfo, AgentState, FirstRunEnv, RigAccountState, RigSignInState } from './env';
import { StepFrame, type StepProps } from './first-run';

/**
 * Step 2: the two things the catch-up needs. A Rig account, which holds the
 * Feed, spaces and corrections; and the routed agent signed in so that it
 * reaches the person's connectors (for Claude, a Claude account login, not
 * an API key). Continue waits for both.
 */
export function SetupStep({ env, position, onNext, setFieldLook }: StepProps) {
  useEffect(() => setFieldLook('dim'), [setFieldLook]);

  // Ask past every cache on the way in, and whenever the window comes back
  // (a sign-in finished in the browser or a terminal).
  const recheck = useRef(env.recheck);
  recheck.current = env.recheck;
  useEffect(() => {
    recheck.current();
    const onFocus = () => recheck.current();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const rigReady = env.rig.kind === 'signedIn';
  const agentReady = env.agent.kind === 'ready';
  const ready = rigReady && agentReady;
  const returning = env.rig.kind === 'signedOut' || env.rig.kind === 'expired';
  const { route } = env.agentInfo;

  return (
    <StepFrame
      guide={
        <>
          <span className="font-mono text-2xs tracking-[0.09em] text-text-muted uppercase">
            {position ? `${position} · Set up` : 'Set up'}
          </span>
          <h1 className="m-0 font-display text-2xl leading-[1.15] font-semibold tracking-[-0.015em] text-balance text-text-primary">
            {ready
              ? 'You’re all set.'
              : returning
                ? 'Welcome back. Two quick checks.'
                : 'Two things first.'}
          </h1>
          <p className="m-0 text-chat leading-[1.55] text-text-secondary">
            {ready
              ? `Your Rig account and ${route.yours} are connected.`
              : `Rig keeps your Feed in your Rig account, and does the work through ${route.yours}.`}
          </p>
          <div className="flex flex-col gap-2" data-testid="first-run-setup-rows">
            <RigRow env={env} />
            <AgentRow env={env} />
          </div>
          <div className="flex-1" />
          <div className="flex flex-wrap items-center gap-2.5">
            <ActionButton
              variant="primary"
              icon={Play}
              onClick={onNext}
              disabled={!ready}
              data-testid="first-run-continue"
            >
              Continue
            </ActionButton>
            {!ready && (
              <span className="text-meta text-text-muted">Both are needed to catch you up</span>
            )}
          </div>
        </>
      }
      stage={<Pair rigOn={rigReady} agentOn={agentReady} agent={env.agentInfo} />}
    />
  );
}

function RigRow({ env }: { env: FirstRunEnv }) {
  // "I already have one" only changes the copy: Clerk's page offers both.
  const [haveOne, setHaveOne] = useState(false);
  const rig: RigAccountState = env.rig;
  const signIn: RigSignInState = env.rigSignIn;
  const mark = <RigMark size={15} />;

  if (rig.kind === 'signedIn') {
    const who = rig.email ? `Signed in as ${rig.email}` : 'Signed in';
    return (
      <Need tone="ok" logo={mark} title="Rig account" done>
        {rig.unverified ? `${who}. Couldn’t check with Rig just now.` : who}
      </Need>
    );
  }
  if (signIn.phase !== 'idle') {
    return (
      <Need logo={mark} title="Finish in your browser">
        We opened userig.xyz. Come back here when you’re done.
        <Acts>
          <Spinner />
          {signIn.url && <CopyLink text={signIn.url} label="Copy the link instead" />}
          <button
            type="button"
            className="text-meta text-text-muted hover:text-text-primary"
            onClick={env.cancelRigSignIn}
          >
            Cancel
          </button>
        </Acts>
      </Need>
    );
  }
  if (rig.kind === 'checking') {
    return (
      <Need logo={mark} title="Rig account">
        <span className="inline-flex items-center gap-2">
          <Spinner /> Checking your Rig account…
        </span>
      </Need>
    );
  }

  const error = signIn.error && <p className="m-0 mt-1.5 text-xs text-danger">{signIn.error}</p>;
  if (rig.kind === 'new' && !haveOne) {
    return (
      <Need logo={mark} title="Create your Rig account">
        Free. Opens your browser to sign up with Google or email.
        {error}
        <Acts>
          <ActionButton
            size="sm"
            variant="primary"
            icon={UserPlus}
            onClick={env.startRigSignIn}
            data-testid="first-run-rig-create"
          >
            Create account
          </ActionButton>
          <LinkButton onClick={() => setHaveOne(true)}>I already have one</LinkButton>
        </Acts>
      </Need>
    );
  }
  const expired = rig.kind === 'expired';
  return (
    <Need logo={mark} title={expired ? 'Sign in again' : 'Sign in to Rig'}>
      {expired
        ? 'Your Rig sign-in on this Mac has expired. Your spaces and Feed are still there.'
        : 'Opens your browser. Your spaces and Feed come with you.'}
      {error}
      <Acts>
        <ActionButton
          size="sm"
          variant="primary"
          icon={LogIn}
          onClick={env.startRigSignIn}
          data-testid="first-run-rig-sign-in"
        >
          {expired ? 'Sign in again' : 'Sign in'}
        </ActionButton>
        {rig.kind === 'new' && (
          <LinkButton onClick={() => setHaveOne(false)}>I need an account</LinkButton>
        )}
      </Acts>
    </Need>
  );
}

function AgentRow({ env }: { env: FirstRunEnv }) {
  const agent: AgentState = env.agent;
  const { name, icon, route } = env.agentInfo;
  const logo = icon ? <AgentIcon icon={icon} size={16} /> : <DotMatrix state="idle" size="sm" />;

  switch (agent.kind) {
    case 'ready':
      return (
        <Need tone="ok" logo={logo} title={name} done>
          Signed in with your {route.account}
          {agent.account ? ` (${agent.account})` : ''}, so Rig can reach your connectors.
        </Need>
      );
    case 'checking':
      return (
        <Need logo={logo} title={name}>
          <span className="inline-flex items-center gap-2">
            <Spinner /> Checking {name} on this Mac…
          </span>
        </Need>
      );
    case 'signingIn':
      return (
        <Need logo={logo} title={`Finish signing in to ${name}`}>
          Sign in with your {route.account} in the window that opened. Come back here when you’re
          done.
          <Acts>
            <Spinner />
          </Acts>
        </Need>
      );
    case 'installing':
      return (
        <Need logo={logo} title={`Installing ${name}…`}>
          About a minute. You can keep going with your Rig account.
          <Acts>
            <Spinner />
          </Acts>
        </Need>
      );
    case 'missing':
      return (
        <Need logo={logo} title={`Install ${name}`}>
          Rig does its work through {name}.{agent.installCommand ? ' One command:' : ''}
          {agent.installCommand && <Command text={agent.installCommand} />}
          <Acts>
            <ActionButton
              size="sm"
              variant="primary"
              icon={Download}
              onClick={env.installAgent}
              data-testid="first-run-agent-install"
            >
              Install for me
            </ActionButton>
          </Acts>
        </Need>
      );
    case 'apiKey':
      return (
        <Need tone="warn" logo={logo} title={`${name} is using an API key`}>
          Rig reads through your {route.connectorsHome} connectors, which need your {route.account}.
          Your key keeps working for everything else.
          <Acts>
            <ActionButton
              size="sm"
              variant="primary"
              icon={LogIn}
              onClick={env.signInAgent}
              data-testid="first-run-agent-sign-in"
            >
              Sign in with {route.brand}
            </ActionButton>
          </Acts>
        </Need>
      );
    case 'signedOut':
      return (
        <Need logo={logo} title={`Sign in to ${name}`}>
          {name} is installed. Sign in with your {route.account}.
          <Acts>
            <ActionButton
              size="sm"
              variant="primary"
              icon={LogIn}
              onClick={env.signInAgent}
              data-testid="first-run-agent-sign-in"
            >
              Sign in
            </ActionButton>
          </Acts>
        </Need>
      );
  }
}

/** One thing Rig needs: a logo, what it is, and what to do about it. */
function Need({
  logo,
  title,
  tone,
  done,
  children,
}: {
  logo: ReactNode;
  title: string;
  tone?: 'ok' | 'warn';
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="fr-need fr-in grid grid-cols-[32px_minmax(0,1fr)] gap-3 rounded-[14px] p-3.5"
      data-tone={tone}
      style={{ animationDuration: '400ms' }}
    >
      <span className="grid size-8 place-items-center rounded-[10px] bg-bg-1">{logo}</span>
      <div className="min-w-0">
        <b
          className={`flex items-center gap-2 text-sm font-medium ${tone === 'warn' ? 'text-status-warn' : 'text-text-primary'}`}
        >
          {title}
          {done && <Tick />}
        </b>
        <div className="mt-0.5 text-meta text-text-secondary">{children}</div>
      </div>
    </div>
  );
}

function Acts({ children }: { children: ReactNode }) {
  return <div className="mt-2.5 flex flex-wrap items-center gap-2.5">{children}</div>;
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-meta text-accent hover:opacity-80">
      {children}
    </button>
  );
}

function CopyLink({ text, label }: { text: string; label: string }) {
  const clipboard = useClipboard();
  return (
    <LinkButton onClick={() => clipboard.copy(text)}>
      {clipboard.copied ? 'Copied' : label}
    </LinkButton>
  );
}

function Command({ text }: { text: string }) {
  const clipboard = useClipboard();
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-border-hairline bg-bg-0 px-[9px] py-[7px] font-mono text-xs whitespace-nowrap text-text-secondary">
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
      <button
        type="button"
        onClick={() => clipboard.copy(text)}
        className="ml-auto inline-flex shrink-0 items-center gap-1 text-accent"
      >
        {clipboard.copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {clipboard.copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Spinner() {
  return (
    <Loader2
      className="size-3.5 shrink-0 animate-spin text-accent"
      strokeWidth={2}
      aria-label="Working"
    />
  );
}

function Tick() {
  return (
    <span
      aria-label="Done"
      className="fr-tick inline-grid size-[18px] place-items-center rounded-full bg-status-ok/15 text-status-ok"
    >
      <svg viewBox="0 0 12 12" fill="none" className="size-[11px]">
        <path
          d="M2.5 6.3l2.3 2.2 4.7-5"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** The stage: Rig and the agent, each lit once its side is ready, joined by running matrices. */
function Pair({ rigOn, agentOn, agent }: { rigOn: boolean; agentOn: boolean; agent: AgentInfo }) {
  const both = rigOn && agentOn;
  return (
    <div className="flex flex-col items-center">
      <div className="flex items-center gap-3.5">
        <span className="fr-glass fr-pair-tile size-[76px] rounded-[22px]" data-on={rigOn}>
          <RigMark size={30} />
        </span>
        <span className="flex gap-1.5">
          {Array.from({ length: 4 }, (_, k) => (
            <DotMatrix key={k} state="running" tone={both ? 'accent' : 'mute'} />
          ))}
        </span>
        <span className="fr-glass fr-pair-tile size-[76px] rounded-[22px]" data-on={agentOn}>
          {agent.icon ? (
            <AgentIcon icon={agent.icon} size={32} />
          ) : (
            <DotMatrix state="idle" size="lg" />
          )}
        </span>
      </div>
      <p className="mt-[18px] min-h-[1.5em] text-center text-sm text-text-secondary">
        {both ? `Rig and ${agent.route.yours} are connected` : ''}
      </p>
    </div>
  );
}
