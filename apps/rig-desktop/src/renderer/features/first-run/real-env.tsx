import { err, ok } from '@emdash/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { cliLoginMethod } from '@renderer/features/agents/agent-auth-state';
import { useAgentInstaller } from '@renderer/features/agents/agent-install';
import { AgentSignInDialog } from '@renderer/features/agents/agent-sign-in-dialog';
import { afterAgentSignIn, agentAuthQuery } from '@renderer/features/agents/use-agent-auth-probe';
import { useAgentIdentities, useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { toFeedItems } from '@renderer/features/home-feed/real-feed';
import { preferredInstallOptions } from '@renderer/features/onboarding/onboarding-state';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { FIRST_RUN_VERSION, type FirstRunProgress } from '@shared/rig/first-run';
import { agentRoute, ROUTED_AGENT_ID } from './agent-route';
import { watchingFrom, watchWrites } from './connect/sources';
import type { AgentState, FirstRunEnv, FirstWinEnv, RigAccountState } from './env';
import { firstWinOrder } from './first-win/first-win-model';
import { liveFirstRun } from './read/progress-source';

const AUTH_STATUS_KEY = ['rig', 'auth', 'status'];
const ME_KEY = ['rig', 'account', 'me'];
const AGENTS_KEY = ['rig', 'agents', 'list'];
const GH_LOGIN_URL = 'https://cli.github.com/manual/gh_auth_login';

/**
 * The first run against the real world: the Rig token on disk and what the
 * relay says of it, the routed agent's install and sign-in, and settings.
 */
export function RealFirstRunEnv({
  firstRunSeen,
  hasSeenOnboarding,
  progress,
  children,
}: {
  firstRunSeen: number;
  hasSeenOnboarding: boolean;
  progress: FirstRunProgress | null;
  children: (env: FirstRunEnv) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const route = agentRoute(ROUTED_AGENT_ID);

  // ── Rig: a token on disk, then `GET /v1/me` to see the relay still takes it.
  // Asked again whenever the first run opens (a resume too): a token that was fine yesterday may not be now.
  const authStatus = useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: () => rpc.rig.auth.status(),
    refetchOnMount: 'always',
  });
  const tokenOnDisk = authStatus.data?.signedIn === true;
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: () => rpc.rig.account.me(),
    enabled: tokenOnDisk,
    refetchOnMount: 'always',
  });
  const signIn = useRigSignIn();

  const rig = useMemo((): RigAccountState => {
    // Only an answer from this mount counts: a cached one may be from before the token lapsed.
    if (authStatus.isPending || !authStatus.isFetchedAfterMount) return { kind: 'checking' };
    if (!tokenOnDisk) return { kind: hasSeenOnboarding ? 'signedOut' : 'new' };
    if (me.isPending || !me.data || !me.isFetchedAfterMount) return { kind: 'checking' };
    if (me.data.success) {
      return {
        kind: 'signedIn',
        email: me.data.data.email,
        name: me.data.data.name,
        unverified: false,
      };
    }
    const error = me.data.error;
    if (error.kind === 'invalidToken') return { kind: 'expired' };
    if (error.kind === 'notSignedIn') return { kind: hasSeenOnboarding ? 'signedOut' : 'new' };
    // Can't reach the relay: the token on disk is all there is to go on.
    return { kind: 'signedIn', email: null, name: null, unverified: true };
  }, [
    authStatus.isPending,
    authStatus.isFetchedAfterMount,
    tokenOnDisk,
    hasSeenOnboarding,
    me.isPending,
    me.isFetchedAfterMount,
    me.data,
  ]);

  // ── The routed agent: installed, and signed in how.
  const agents = useRunnableAgents();
  const identities = useAgentIdentities();
  const payload = agents.data?.find((candidate) => candidate.id === route.id);
  const installed = payload?.status === 'available';
  const loginMethod = payload ? cliLoginMethod(payload.capabilities) : null;
  const authQuery = useQuery(agentAuthQuery(route.id, installed && loginMethod !== null));
  const [signingIn, setSigningIn] = useState(false);
  const { installingId, install } = useAgentInstaller(() => {
    void queryClient.invalidateQueries({ queryKey: AGENTS_KEY });
  });

  const agent = useMemo((): AgentState => {
    if (installingId === route.id) return { kind: 'installing' };
    if (agents.isPending) return { kind: 'checking' };
    if (!installed) {
      const option = payload ? preferredInstallOptions(payload.installOptions)[0] : undefined;
      return { kind: 'missing', installCommand: option?.command ?? null };
    }
    if (signingIn) return { kind: 'signingIn' };
    // No sign-in of its own to check: being installed is all it takes.
    if (!loginMethod) return { kind: 'ready', account: null };
    if (authQuery.isPending) return { kind: 'checking' };
    const auth = authQuery.data;
    if (auth?.kind !== 'authenticated') return { kind: 'signedOut' };
    const account = auth.account ?? null;
    return route.reachesConnectors(auth) ? { kind: 'ready', account } : { kind: 'apiKey', account };
  }, [
    installingId,
    route,
    agents.isPending,
    installed,
    payload,
    signingIn,
    loginMethod,
    authQuery.isPending,
    authQuery.data,
  ]);

  const recheck = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY });
    void queryClient.invalidateQueries({ queryKey: ME_KEY });
    // The runtime caches an agent's sign-in for 15 minutes; this query always asks past it.
    void queryClient.invalidateQueries({ queryKey: agentAuthQuery(route.id, true).queryKey });
    if (!installed) {
      void rpc.agents
        .probeAll()
        .catch(() => undefined)
        .then(() => queryClient.invalidateQueries({ queryKey: AGENTS_KEY }));
    }
  }, [queryClient, route.id, installed]);

  const env: FirstRunEnv = {
    user: { firstRunSeen, hasSeenOnboarding, progress },
    rig,
    rigSignIn: { phase: signIn.phase, url: signIn.url, error: signIn.error },
    agent,
    agentInfo: {
      name: payload?.name ?? identities.get(route.id)?.name ?? route.id,
      icon: payload?.icon ?? identities.get(route.id)?.icon ?? null,
      route,
    },
    recheck,
    startRigSignIn: () => void signIn.signIn(),
    cancelRigSignIn: signIn.cancel,
    installAgent: () => {
      const option = payload ? preferredInstallOptions(payload.installOptions)[0] : undefined;
      if (payload && option) void install(payload, option.method);
    },
    signInAgent: () => setSigningIn(true),
    preflight: () => rpc.rig.firstRun.preflight(),
    readWatching: async () => {
      const sources = await rpc.rig.orch.sources();
      return sources.success ? watchingFrom(sources.data) : {};
    },
    setWatching: async (connector, on) => {
      const sources = await rpc.rig.orch.sources();
      if (!sources.success) return;
      const writes = watchWrites(sources.data, connector, on);
      if (writes.add) await rpc.rig.orch.addSource(writes.add);
      for (const pause of writes.pause) await rpc.rig.orch.pauseSource(pause);
    },
    // GitHub comes through `gh`, not claude.ai: its way in is `gh auth login`.
    openConnect: (connector) =>
      confirmOpenExternalLink(connector === 'github' ? GH_LOGIN_URL : route.connectorsUrl),
    readSource: liveFirstRun,
    catchUpSince: async () => {
      const r = await rpc.rig.orch.since().catch(() => null);
      return r?.success ? r.data.since : null;
    },
    ensureHome: () => void rpc.rig.orch.ensureHome().catch(() => undefined),
    firstWin: realFirstWin,
    saveProgress: (next) => void rpc.rig.settings.set({ firstRunProgress: next }),
    trackStep: (step) =>
      void rpc.telemetry
        .capture({ event: 'first_run_step_viewed', properties: { state: step } })
        .catch(() => undefined),
    finish: () =>
      void rpc.rig.settings.set({
        firstRunSeen: FIRST_RUN_VERSION,
        firstRunProgress: null,
        hasSeenOnboarding: true,
        // The first run ends in the new Home, for those upgrading too.
        newHomeEnabled: true,
      }),
    overlay:
      payload && loginMethod ? (
        <AgentSignInDialog
          open={signingIn}
          onOpenChange={setSigningIn}
          providerId={payload.id}
          methodId={loginMethod.id}
          providerName={payload.name}
          onSuccess={() => {
            afterAgentSignIn(queryClient, payload.id);
            setSigningIn(false);
          }}
        />
      ) : null,
  };

  return <>{children(env)}</>;
}

/** The First win step against the real Feed: the orchestrator's cards, and Send, Start and answers through Rig. */
const realFirstWin: FirstWinEnv = {
  cards: async () => {
    const feed = await rpc.rig.feed.get().catch(() => null);
    return feed?.success ? firstWinOrder(toFeedItems(feed.data, Date.now())) : null;
  },
  send: async (item, choice, text) => {
    if (!item.situationId) return err('This card has nothing to send.');
    const r = await rpc.rig.feed
      .send({
        situationId: item.situationId,
        choice: choice.cardIndex ?? item.choices.indexOf(choice),
        text,
      })
      .catch(() => null);
    if (!r) return err("Rig couldn't reach your Claude.");
    return r.success ? ok(r.data) : err(r.error.message);
  },
  start: async (item, choice) => {
    if (!item.situationId) return err('This card has nothing to start.');
    const r = await rpc.rig.feed
      .start({
        situationId: item.situationId,
        task: `${choice.lead}${choice.tail}`.replace(/[{}@]/g, ''),
      })
      .catch(() => null);
    if (!r) return err("Rig couldn't start it.");
    return r.success
      ? ok({
          said: `Started in #${r.data.space.name}`,
          link: null,
          session: { root: r.data.space.root, sessionId: r.data.runId },
        })
      : err(r.error.message);
  },
  answer: (item, signal) => {
    if (item.situationId)
      void rpc.rig.feed.answer({ situationId: item.situationId, signal }).catch(() => undefined);
  },
};
