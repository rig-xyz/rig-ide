import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, LogIn, Plus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentProblemLine } from '@renderer/features/agents/agent-problem-line';
import { useAgentIdentities, useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { useActivity, useNotificationSummary } from '@renderer/features/notifications/use-notifications';
import { usePeople } from '@renderer/features/people/use-people';
import { deriveSignedIn } from '@renderer/features/rig-account/auth-state';
import { useRigSignIn, type RigSignInPhase } from '@renderer/features/rig-account/use-rig-sign-in';
import { ManualLink } from '@renderer/features/onboarding/sign-in-step';
import { Button } from '@renderer/lib/ui/button';
import { ConnectionBanner } from '@renderer/features/shell/connection-banner';
import {
  MY_INVITES_KEY_PREFIX,
  myInvitesQueryKey,
  shapeMyInvites,
  type MyInviteRow,
} from '@renderer/features/shell/invites-inbox';
import { NeedsConnection } from '@renderer/features/shell/needs-connection';
import { useAutoReconnect, useNavigatorOnline, useWaitedLong } from '@renderer/features/shell/use-connection';
import { requestRoomTheme } from '@renderer/features/spaces/room-theme-request';
import { requestOpenSetup, startSpaceSetup, useSpaceSetups } from '@renderer/features/spaces/space-setup-store';
import { useRoomThemesEnabled } from '@renderer/features/spaces/use-room-themes-enabled';
import { useSpacesEnabled } from '@renderer/features/spaces/use-spaces-enabled';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { AcrossYourSpacesToday } from './across-your-spaces-today';
import { BriefingSpine, loadPulse, PULSE_QUERY_KEY } from './briefing-spine';
import { FloatingCard } from './floating-card';
import {
  deriveHomeConnection,
  needsConnection,
  offlineLastActivity,
  resolveHomeAccountId,
  SLOW_AFTER_MS,
  withRememberedWorkspaces,
} from './home-connection';
import {
  buildHomeRigRows,
  deriveHomeRegions,
  deriveWorkspacesState,
  filterLocalRigsByAccount,
  type HomeHealthMessage,
  type HomeLocalRig,
  type HomeRecentSession,
  type LegacyRowVisibility,
} from './home-sections';
import { WaitingOnYouSection } from './needs-you-section';
import { NewSpaceCta } from './new-space-cta';
import { PeopleRail } from './people-rail';
import { shouldShowPulseSection } from './pulse-state';
import {
  avatarsByFirstName,
  deriveAcrossSpacesView,
  firstNameKey,
  lastActivityByPerson,
  markTopics,
  topicBySpace,
} from './recent-themes-state';
import { RigsRail } from './rigs-rail';
import { generateSpaceName } from './space-create';
import { useShowPlainRigs } from './use-show-plain-rigs';
import { indexSpaceStatuses } from './space-status-state';
import { SpacesCard } from './spaces-card';
import { useRecentThemes, RECENT_THEMES_QUERY_KEY } from './use-recent-themes';
import { useSpaceStatus } from './use-space-status';
import { useFaceReasons } from './use-face-reasons';
import { deriveAskChips } from './ask-chips';
import { unreadMentionsBySpace } from './face-reasons';
import { InviteLinkField } from './invite-link-field';
import { InviteWelcome } from './invite-welcome';
import { deriveWelcomePhase, type WelcomePhase } from './welcome-state';

/**
 * Round: HOME RESTRUCTURE — Dylan-approved IA, structurally referencing
 * the web hub home (`hub/web`'s `app/home/page.tsx`: sidebar/center/rail),
 * restyled to this app's own tokens rather than copied. Two regions:
 *
 *   LEFT   — `RigsRail`, the action zone: ONE rig-centric list (kills the
 *            old separate CONTINUE + RIGS sections and the mid-page "Open
 *            a rig" hero — the true empty state below is now the first-run
 *            `Welcome` screen instead, see onboarding-flow-spec.md).
 *   CENTER — `BriefingSpine`, the pulse briefing (kicker, greeting,
 *            summary, ask, WHAT'S NEW).
 *            Then "Across your spaces today", a flat feed.
 *   RIGHT  — `PeopleRail`, per-person pulse lines, a plain column
 *            (absent when there's no one to show). Below 1400px there's no
 *            room for it, so it sits under the topics instead.
 *
 * `showPulse` (`shouldShowPulseSection`, UNCHANGED semantics) gates the
 * center region — signed-out and "solo" (no relay
 * bindings) render the rigs rail alone, which works standalone by design.
 * The true empty state (no rigs anywhere) pre-empts everything else: the
 * first-run `Welcome` screen, one line and one button
 * (docs/onboarding-flow-spec.md §1).
 */
export function Home({
  onOpenFolder,
  onOpenPath,
  onContinueSession,
  onRigCreated,
}: {
  onOpenFolder: () => void;
  onOpenPath: (path: string, opts?: { openFilePath?: string; kind?: 'space' }) => void;
  onContinueSession: (path: string, sessionId: string) => void;
  /**
   * Onboarding flow round (docs/onboarding-flow-spec.md §2): fires once the
   * one-click create (Welcome's "Start fresh", or the rail's "New rig")
   * actually created a rig — `App.tsx` opens it and arms the topbar's
   * inline auto-rename and the landing-doc open.
   */
  onRigCreated: (path: string, docPath: string | null, kind?: 'space') => void;
}) {
  const { agents, isLoading: agentsLoading } = useRunnableAgents();
  const identities = useAgentIdentities();
  const queryClient = useQueryClient();
  // Re-entrancy guard, not React state — a second click while the first
  // create is still in flight should just no-op, not start a second rig.
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  // Why the last Start fresh didn't make anything, shown under the button.
  const [createError, setCreateError] = useState<string | null>(null);

  // One-click create (onboarding-flow-spec.md §2): Welcome's "Start fresh"
  // and the rail's "New rig" both drive this exact same request — no
  // dialog, no name field. "Untitled rig" is collision-suffixed by main
  // (rig-home-design.md) and lands in the managed `~/Rig` home; the seed
  // doc is written main-side (`seedDoc: true`) so there is something real
  // to land on.
  const createRig = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await rpc.rig.create.create({
        parentDir: null,
        name: 'Untitled rig',
        sync: true,
        seedDoc: true,
      });
      if (!result.success) {
        setCreateError(result.error.message);
        return;
      }
      if (result.data.rootId) void rpc.rig.files.releaseRoot({ rootId: result.data.rootId });
      void queryClient.invalidateQueries({ queryKey: ['rig', 'recent'] });
      void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
      onRigCreated(result.data.path, result.data.docPath);
    } catch {
      setCreateError(START_FRESH_FAILED);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [queryClient, onRigCreated]);
  // Spaces: "New space" opens the new space's Room at once (App, via
  // `startSpaceSetup`) while main sets it up in the background. Returns an
  // error message to show under the pill when not even its folder could be
  // made, or null.
  const spacesEnabled = useSpacesEnabled();
  const createSpace = startSpaceSetup;
  // Plain rigs are hidden while spaces are on, unless Settings › Spaces shows
  // them; hidden, Welcome's "Start fresh" makes a space, named like the New
  // space button names one.
  const showPlainRigs = useShowPlainRigs();
  const rigsHidden = spacesEnabled && !showPlainRigs;
  const spaceNamesRef = useRef<ReadonlySet<string>>(new Set());
  // Same guard as `createRig`: a second click while the space is starting
  // does nothing, so a double click never makes two spaces.
  const createFirst = useCallback(async () => {
    if (!rigsHidden) return createRig();
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const error = await createSpace(generateSpaceName(spaceNamesRef.current)).catch(() => START_FRESH_FAILED);
      if (error) setCreateError(error);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [rigsHidden, createSpace, createRig]);
  const spaceSetups = useSpaceSetups();
  // Pulse round: which rigs-rail row a WHAT'S NEW/ACROSS YOUR RIGS rig-name
  // link (no local match) should scroll to/flash — lives here, not in
  // either `BriefingSpine` or `RigsRail` alone, since it's the one piece of
  // state that crosses between them (center → left).
  const [highlightBindingId, setHighlightBindingId] = useState<string | null>(null);

  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const authStatusSignedIn = authQuery.data?.signedIn ?? false;

  // Accounts & rigs round: same query key `user-pill.tsx` already uses for
  // the topbar identity pill, so this shares that cache/subscription rather
  // than firing a second `/v1/me` — only the rail's own account filter
  // (`filterLocalRigsByAccount` below) reads it here. Enabled off the RAW
  // `auth.status` signal (a token file exists), not the derived `signedIn`
  // below — `signedIn` itself depends on this query's own result (a
  // rejected token downgrades it back to signed-out), so gating it on that
  // would be circular.
  const meQuery = useQuery({
    queryKey: ['rig', 'account', 'me'],
    queryFn: () => rpc.rig.account.me(),
    enabled: authStatusSignedIn,
  });

  // `auth.status`'s `signedIn` only means "a token file exists" — see
  // `deriveSignedIn`'s own doc comment for why a 401 `invalid_token` from
  // the `me` query above downgrades this back to signed-out.
  const signedIn = deriveSignedIn(
    authStatusSignedIn,
    meQuery.data?.success === false ? meQuery.data.error : undefined
  );

  // Onboarding-flow spec, Decisions ("Sign-in on Start fresh, option A"): a
  // signed-out click on Welcome's "Start fresh" (or the rail's "New rig",
  // same `createRig` above) runs the existing `rig login` round-trip first
  // — `onSuccess` continues straight into `createRig()` with no second
  // click. A signed-in click skips this hook entirely (see
  // `startFreshOrCreate` below) and behaves exactly as before.
  const {
    signIn: signInThenCreateRig,
    phase: createSignInPhase,
    error: createSignInError,
    url: createSignInUrl,
    cancel: cancelCreateSignIn,
  } = useRigSignIn(() => void createFirst());

  const startFreshOrCreate = useCallback(() => {
    if (signedIn) {
      void createFirst();
    } else {
      void signInThenCreateRig();
    }
  }, [signedIn, createFirst, signInThenCreateRig]);

  const welcomePhase: WelcomePhase = deriveWelcomePhase({
    authLoading: authQuery.isLoading,
    signedIn,
    signInPhase: createSignInPhase,
    signInError: createSignInError,
    creating,
    createError,
  });

  const workspacesQuery = useQuery({
    queryKey: ['rig', 'account', 'workspaces'],
    queryFn: () => rpc.rig.account.workspaces(),
    enabled: signedIn,
  });

  // Bumped well past the old CONTINUE section's cap of 7 — every local rig
  // needs to genuinely appear in ITS OWN row now, not just the most
  // recently opened handful, or a rig that fell outside the limit would
  // wrongly render as "shared with you, not set up locally" even though
  // it's sitting right there on disk (`resolveLocalPaths` would still find
  // it, but with none of its own name/sessions).
  const localRigsQuery = useQuery({
    queryKey: ['rig', 'recent', 'list'],
    queryFn: () => rpc.rig.recent.recentRigs(50),
    staleTime: 5_000,
  });

  // Bumped from the old flat CONTINUE section's cap of 5 (one shared list)
  // to enough headroom for several rigs to each carry their own few
  // sessions — `groupSessionsByRig` caps per rig, this just needs enough
  // raw rows to distribute.
  const recentSessionsQuery = useQuery({
    queryKey: ['rig', 'sessions', 'recentAcrossRigs'],
    queryFn: () => rpc.rig.sessions.listRecentAcrossRigs({ limit: 30 }),
    staleTime: 5_000,
  });

  const { signIn, phase: signInPhase, url: signInUrl, cancel: cancelSignIn } = useRigSignIn();

  const localReady = !agentsLoading && !localRigsQuery.isLoading && !recentSessionsQuery.isLoading;

  // Accounts & rigs round: `undefined` while signed in but `meQuery` hasn't
  // resolved yet (never filter on a guess), `null` once confidently signed
  // out, else the signed-in account's own id — see
  // `filterLocalRigsByAccount`'s own doc comment for what each does below.
  //
  // Offline round: while `/v1/me` hasn't answered (or can't), the account
  // this same token was last seen as — read from this computer — stands in,
  // so an offline Home never shows another account's rows
  // (`resolveHomeAccountId`).
  const offlineSnapshotQuery = useQuery({
    queryKey: ['rig', 'offline', 'homeSnapshot'],
    queryFn: () => rpc.rig.offline.homeSnapshot(),
    enabled: authStatusSignedIn,
  });
  const offlineSnapshot = offlineSnapshotQuery.data;
  const currentAccountId: string | null | undefined = resolveHomeAccountId({
    signedIn,
    meId: meQuery.data?.success ? meQuery.data.data.id : undefined,
    meFailed: meQuery.data?.success === false,
    rememberedAccountId: offlineSnapshotQuery.isLoading ? undefined : (offlineSnapshot?.accountId ?? null),
  });

  // Part C (feedback round): Home's own read of "invites addressed to me" —
  // shares the exact same account-scoped cache key the topbar bell uses
  // (`invites-inbox.ts`'s `myInvitesQueryKey`), so the two rarely cost two
  // separate relay round trips. Feeds only the empty-state's inline invite
  // banner below; the bell stays the primary surface.
  const myInvitesQuery = useQuery({
    queryKey: myInvitesQueryKey(currentAccountId ?? null),
    queryFn: () => rpc.rig.share.listMyInvites(),
    enabled: signedIn,
  });
  const pendingInvites: MyInviteRow[] = myInvitesQuery.data?.success
    ? shapeMyInvites(myInvitesQuery.data.data.invites)
    : [];

  const workspaces = deriveWorkspacesState(signedIn, {
    isLoading: workspacesQuery.isLoading,
    data: workspacesQuery.data,
  });
  // What the rows are built from: the live list, or — while it loads or the
  // relay is out of reach — this account's last known one from this computer.
  const rowWorkspaces = withRememberedWorkspaces(workspaces, offlineSnapshot?.workspaces?.bindings ?? null);

  // Offline round: slow is not offline. Only a failed answer (or no network
  // at all) flips Home to "showing what's on this computer"; a first load
  // that's merely slow gets a quiet hint after `SLOW_AFTER_MS`.
  const navigatorOnline = useNavigatorOnline();
  const waitedLong = useWaitedLong(signedIn && workspaces.status === 'loading', SLOW_AFTER_MS);
  const connection = deriveHomeConnection({ signedIn, navigatorOnline, workspaces, waitedLong });
  const connectionDown = needsConnection(connection);
  const { retrying, tryAgain } = useAutoReconnect({
    down: connectionDown,
    autoRetry: connection === 'unreachable',
    retry: () => {
      void queryClient.invalidateQueries({ queryKey: ['rig', 'spaceStatus'] });
      void queryClient.invalidateQueries({ queryKey: RECENT_THEMES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ['rig', 'pulse'] });
      void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
      return Promise.all([
        workspacesQuery.refetch(),
        offlineSnapshotQuery.refetch(),
        ...(authStatusSignedIn ? [meQuery.refetch()] : []),
      ]);
    },
  });
  // A list that just failed: re-read the remembered one, which the last
  // success this session may have updated since launch.
  const refetchOfflineSnapshot = offlineSnapshotQuery.refetch;
  useEffect(() => {
    if (workspaces.status === 'unreachable') void refetchOfflineSnapshot();
  }, [workspaces.status, refetchOfflineSnapshot]);

  // Part B (feedback round, docs/onboarding-flow-spec.md "Accounts &
  // rigs"): a legacy row only counts as this account's own once its
  // bindingId shows up in the account's OWN relay workspaces —
  // `deriveWorkspacesState`'s `'ok'` already carries exactly that list.
  // `'loading'`/`'unreachable'` fall back to `'showAll'` (never hide a
  // legacy row on a guess, or while offline) — see
  // `filterLocalRigsByAccount`'s own doc comment. `ownedBindingIdsKey` is a
  // stable, sorted-and-joined string of the same ids — react hooks can't
  // usefully depend on `workspaces.bindings` itself (a fresh array every
  // render) or a `Set` built from it (same problem), so the backfill
  // effect below depends on this instead, via the memoized `ownedBindingIds`.
  const ownedBindingIdsKey =
    rowWorkspaces.status === 'ok'
      ? [...rowWorkspaces.bindings]
          .map((b) => b.bindingId)
          .sort()
          .join(',')
      : '';
  const ownedBindingIds = useMemo(
    () => new Set(ownedBindingIdsKey ? ownedBindingIdsKey.split(',') : []),
    [ownedBindingIdsKey]
  );
  const legacyVisibility: LegacyRowVisibility =
    rowWorkspaces.status === 'ok' ? { kind: 'ownedOnly', bindingIds: ownedBindingIds } : { kind: 'showAll' };

  // Filtered once, here, so every consumer below (the rail, and the pulse
  // briefing's own "your rigs" via `BriefingSpine`) agrees on the same
  // account boundary rather than each re-deriving it.
  const localRigs: HomeLocalRig[] = filterLocalRigsByAccount(
    (localRigsQuery.data ?? []).map((r) => ({
      bindingId: r.bindingId,
      name: r.name,
      path: r.path,
      lastOpenedAt: r.lastOpenedAt,
      paused: r.paused,
      outsideHome: r.outsideHome,
      notARigAnymore: r.notARigAnymore,
      accountId: r.accountId,
    })),
    currentAccountId,
    legacyVisibility
  );
  const recentSessions: HomeRecentSession[] = recentSessionsQuery.data ?? [];

  // Backfill half of Part B: once a legacy row is CONFIRMED as this
  // account's own (its bindingId is in `legacyVisibility`'s `ownedOnly`
  // set), stamp `accountId` on it for good so it stops depending on
  // re-deriving ownership from the relay on every future render. Best-
  // effort and idempotent (`backfillAccountId`'s own doc comment) — the ref
  // just avoids re-issuing the same call every render for bindingIds
  // already sent this session.
  const backfilledBindingIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (workspaces.status !== 'ok' || typeof currentAccountId !== 'string') return;
    const toBackfill = (localRigsQuery.data ?? [])
      .filter(
        (r) =>
          r.accountId === null && ownedBindingIds.has(r.bindingId) && !backfilledBindingIds.current.has(r.bindingId)
      )
      .map((r) => r.bindingId);
    if (toBackfill.length === 0) return;
    for (const bindingId of toBackfill) backfilledBindingIds.current.add(bindingId);
    void rpc.rig.recent.backfillAccountId({ bindingIds: toBackfill, accountId: currentAccountId });
  }, [workspaces.status, ownedBindingIds, currentAccountId, localRigsQuery.data]);

  const localBindingIds = new Set(localRigs.map((r) => r.bindingId));
  const relayOnlyBindingIds =
    rowWorkspaces.status === 'ok'
      ? rowWorkspaces.bindings.map((b) => b.bindingId).filter((id) => !localBindingIds.has(id))
      : [];
  const localPathsQuery = useQuery({
    queryKey: ['rig', 'recent', 'resolveLocalPaths', relayOnlyBindingIds],
    queryFn: () => rpc.rig.recent.resolveLocalPaths({ bindingIds: relayOnlyBindingIds }),
    enabled: relayOnlyBindingIds.length > 0,
  });
  const localPaths = new Map(Object.entries(localPathsQuery.data ?? {}));
  // D7 fix: a DISABLED query (no relay-only bindings at all) stays
  // "loading" forever in react-query's own semantics — gated on there
  // being anything to actually resolve, so a rig list with zero relay-only
  // rows never shows a permanent, meaningless pending state.
  const localPathsPending = relayOnlyBindingIds.length > 0 && localPathsQuery.isLoading;

  const regions = localReady
    ? deriveHomeRegions({
        signedIn,
        hasRunnableAgent: agents.length > 0,
        localRigs,
        recentSessions,
        workspaces: rowWorkspaces,
      })
    : { showRigs: false, showEmptyState: true, health: null };

  const rigRows = regions.showRigs
    ? buildHomeRigRows(localRigs, rowWorkspaces, recentSessions, localPaths, localPathsPending)
    : [];

  // Home restructure, "spaces first": spaces get their own floating card
  // (`SpacesCard`) with a live status tile per row; plain rigs are demoted
  // into the "Solo rigs" card (`RigsRail`, now spaces-free — see its own
  // header comment).
  const spaceRows = spacesEnabled ? rigRows.filter((row) => row.isSpace) : [];
  const soloRigRows = spacesEnabled ? rigRows.filter((row) => !row.isSpace) : rigRows;
  // Instant new space: a row for each space still being set up, until it
  // shows up in the list for real (a live one lingers until the lists refresh).
  const settingUpSpaces = [...spaceSetups.values()].filter(
    (setup) => setup.status !== 'live' || !spaceRows.some((row) => row.bindingId === setup.bindingId)
  );
  // New-space CTA: the collision check `generateSpaceName` runs against.
  const spaceNames = new Set([
    ...spaceRows.map((row) => row.name).filter((name): name is string => !!name),
    ...settingUpSpaces.map((setup) => setup.name),
  ]);
  spaceNamesRef.current = spaceNames;
  // Offline: each space's last activity from this computer (opened here, its chats, its saved chat).
  const offlineActivity = new Map(
    spaceRows.map((row) => [
      row.bindingId,
      offlineLastActivity(
        row.kind === 'local' ? row : { sessions: [] },
        offlineSnapshot?.roomSavedAt[row.bindingId]
      ),
    ])
  );

  const showPulse = shouldShowPulseSection(
    signedIn,
    workspaces.status === 'ok'
      ? { status: 'ok', bindingCount: workspaces.bindings.length }
      : { status: workspaces.status }
  );

  // Polish round, lane C: `rpc.rig.spaceStatus.get()`'s per-space live
  // status — polled gently (`use-space-status.ts`), only while there's
  // any reason to (Spaces enabled + signed in; a signed-out/solo window
  // has no spaces to ask about). `selfUserId` reuses the SAME account id
  // `filterLocalRigsByAccount` above already resolved — the relay's own
  // `users.id`, which is exactly what `RigSpaceRunningItem.ownerUserId`
  // is keyed on (confirmed against `tap`'s `session_runs.owner_user_id`).
  const spaceStatusQuery = useSpaceStatus(spacesEnabled && signedIn);
  // Offline, a status read before the drop is no longer live: none is shown.
  const statusByBinding = indexSpaceStatuses(
    spaceStatusQuery.data?.success && !connectionDown ? spaceStatusQuery.data.data : []
  );
  const selfUserId = currentAccountId ?? null;

  // "Many spaces on Home" v2: one read of the relay's Room themes of the last
  // 24h feeds both "Across your spaces today" and each Spaces row's topic.
  const recentThemes = useRecentThemes(spacesEnabled && signedIn, currentAccountId);
  const acrossView = deriveAcrossSpacesView({ ...recentThemes, offline: connectionDown });
  // Offline, like the rows' live status, no row claims a topic.
  const topicByBinding = topicBySpace(acrossView.kind === 'themes' && !connectionDown ? acrossView.themes : []);
  const roomThemesOn = useRoomThemesEnabled();
  // Each space's read cursor and unread count, the relay's (the Activity
  // bell's summary): topics past it are marked new, the rest step back.
  const notificationSummary = useNotificationSummary();
  const spaceReads = new Map(
    notificationSummary.spaces.map((s) => [s.bindingId, { cursor: s.lastReadSeq, unread: s.spaceUnread }])
  );
  const topicMarks = markTopics(acrossView.kind === 'themes' && !connectionDown ? acrossView.themes : [], spaceReads);
  // Faces only when they're the reason: who mentioned you, who left unread
  // work, whose agent is running. The Activity rows give the mentions.
  const activity = useActivity(spacesEnabled && signedIn);
  const facesByBinding = useFaceReasons({
    bindingIds: spaceRows.map((r) => r.bindingId),
    statusByBinding,
    summarySpaces: notificationSummary.spaces,
    activity,
    selfUserId,
    enabled: spacesEnabled && signedIn && !connectionDown,
  });
  // Ask's chips, from what's on this screen: no model call.
  const unreadBySpace = new Map(notificationSummary.spaces.map((s) => [s.bindingId, s.spaceUnread]));
  const askChips = deriveAskChips({
    spaces: spaceRows.map((r) => ({
      bindingId: r.bindingId,
      name: r.name ?? 'Untitled space',
      unread: connectionDown ? 0 : (unreadBySpace.get(r.bindingId) ?? 0),
    })),
    mentions: connectionDown
      ? []
      : [...unreadMentionsBySpace(activity ?? []).values()]
          .flat()
          .filter((n) => n.actor.kind === 'user' && n.actor.name)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((n) => ({
            bindingId: n.bindingId!,
            spaceName: n.spaceName ?? spaceRows.find((r) => r.bindingId === n.bindingId)?.name ?? 'this space',
            who: n.actor.name!,
          })),
    topics:
      acrossView.kind === 'themes' && !connectionDown
        ? [...acrossView.themes]
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
            .map((t) => ({
              bindingId: t.bindingId,
              spaceName: t.spaceName,
              name: t.name,
              isNew: topicMarks.get(t.themeId)?.kind === 'new',
              people: t.people,
            }))
        : [],
  });
  // The topic lines' faces and People's times both come from what Home
  // already reads: the day's themes, and pictures from you, your people and
  // Pulse's people. Pulse alone misses anyone its briefing leaves out.
  const pulseQuery = useQuery({
    queryKey: PULSE_QUERY_KEY,
    queryFn: () => loadPulse(queryClient),
    staleTime: 60_000,
    enabled: showPulse,
  });
  const { people: yourPeople } = usePeople(showPulse && spacesEnabled);
  const avatarByName = avatarsByFirstName(
    meQuery.data?.success ? [meQuery.data.data] : [],
    yourPeople,
    pulseQuery.data?.success ? pulseQuery.data.data.briefing.perPerson : []
  );
  const avatarOf = (name: string) => avatarByName.get(firstNameKey(name) ?? '') ?? null;
  const lastActivity = lastActivityByPerson(acrossView.kind === 'themes' ? acrossView.themes : []);
  // A theme line opens its space's Room, on that theme when Room themes is
  // on. A space with no folder here yet is flashed in the Spaces card.
  const openSpaceOnTheme = (bindingId: string, themeId: string) => {
    const row = spaceRows.find((r) => r.bindingId === bindingId);
    const path = row?.kind === 'local' ? row.path : (row?.localPath ?? null);
    if (!path) {
      setHighlightBindingId(bindingId);
      return;
    }
    if (roomThemesOn) requestRoomTheme(bindingId, themeId);
    onOpenPath(path, { kind: 'space' });
  };

  // Feedback round, Part A: signing out (or never having signed in on this
  // launch) must not leave any rig visible on Home — a single generic gate
  // replaces the whole screen the moment auth confidently resolves to
  // signed-out. `authQuery.isLoading` guards against flashing this gate
  // during the brief window auth status is still unknown (`signedIn`
  // defaults to `false` then too, same as before this round) — that
  // existing loading behavior is unchanged. A genuinely fresh machine (no
  // local rigs, no sessions — the first-run empty state) keeps the
  // onboarding spec's Welcome instead: its one button already signs in
  // before creating, and "Start fresh" is the honest verb there, not
  // "Sign in to see your rigs" when there is nothing to see yet.
  if (!authQuery.isLoading && !signedIn && !regions.showEmptyState) {
    return (
      <div className="flex min-h-full w-full items-center justify-center p-8">
        <SignedOutGate
          signInPhase={signInPhase}
          onSignIn={signIn}
          signInUrl={signInUrl}
          onCancel={cancelSignIn}
          expired={authStatusSignedIn && meQuery.data?.success === false && meQuery.data.error.kind === 'invalidToken'}
        />
      </div>
    );
  }

  if (regions.showEmptyState) {
    // `min-h-full` (not `h-full`) + no overflow of its own — `main` (the
    // parent, in `App.tsx`) is what scrolls; matches round H2's own fix
    // for the classic flexbox-centering-clips-the-top bug.
    //
    // Onboarding flow round: this is now the ONLY first-run surface
    // (docs/onboarding-flow-spec.md §1) — no Open Folder…, no "ask your
    // agent", no dialog. One line, one button.
    //
    // Part C (feedback round): an account with zero rigs but a pending
    // invite gets it surfaced right here too, not only behind the topbar
    // bell — `pendingInvite` is null whenever there isn't one (no invites,
    // or the read hasn't resolved yet), so this never changes layout for
    // the plain first-run case.
    return (
      <div className="flex min-h-full w-full flex-col items-center justify-center gap-6 p-8">
        {pendingInvites.length > 0 ? (
          <InviteWelcome
            invites={pendingInvites}
            icon={<RigAppIcon size={112} className="shadow-soft" />}
            onOpenPath={onOpenPath}
            onStartFresh={startFreshOrCreate}
            startFreshPhase={welcomePhase}
            needsConnection={connectionDown || !navigatorOnline}
          >
            <InviteLinkField onOpenPath={onOpenPath} needsConnection={connectionDown || !navigatorOnline} />
          </InviteWelcome>
        ) : (
          <Welcome
            phase={welcomePhase}
            authLoading={authQuery.isLoading}
            onStartFresh={startFreshOrCreate}
            signInUrl={createSignInUrl}
            onCancelSignIn={cancelCreateSignIn}
            // Signing in and creating both need the network.
            needsConnection={connectionDown || !navigatorOnline}
            // Signed out: sign in on its own, to see invites, without making a space.
            signInOnly={
              !authQuery.isLoading && !signedIn
                ? { onSignIn: () => void signIn(), phase: signInPhase, url: signInUrl, onCancel: cancelSignIn }
                : undefined
            }
          >
            <InviteLinkField onOpenPath={onOpenPath} needsConnection={connectionDown || !navigatorOnline} />
          </Welcome>
        )}
        {/* Skipped the agent step on the first run: the way back to it, one line per agent. */}
        {localReady && (
          <div className="flex flex-col gap-1.5" data-testid="home-agent-problems">
            <AgentProblemLine agentId="claude" variant="home" showMissing={agents.length === 0} />
            <AgentProblemLine agentId="codex" variant="home" showMissing={agents.length === 0} />
          </div>
        )}
      </div>
    );
  }

  return (
    // Polish round (Dylan's own diagnosis): the greeting read as sitting
    // behind an oversized "white strip" — the topbar's own clearance
    // (`App.tsx`'s `pt-10` on `main`, 40px) plus this wrapper's full 24px top
    // padding stacked into too much empty space before content started.
    // The fix is content proximity, not bar decoration: `pt-3` only (12px,
    // still a real scale step, not zero) instead of the uniform `p-6`,
    // right/bottom/left unchanged.
    // Glow v4: anchored to the window's own top edge (`.hero-glow` reaches
    // up under the bare Home top bar), where a wash starting at full
    // intensity reads as chrome; floating mid-content it read as a cut-off box. Ellipse radii sized so
    // alpha hits zero before either horizontal edge. Padding widened per
    // Dylan: the column was crowding the rail.
    <div className="hero-glow flex min-h-full w-full flex-col gap-4 px-10 pt-4 pb-8 lg:pr-24 lg:pl-16 min-[87.5rem]:pr-16">
      {connection !== 'online' && (
        <ConnectionBanner connection={connection} retrying={retrying} onTryAgain={tryAgain} />
      )}
      {regions.health && <HealthLine message={regions.health} onSignIn={signIn} signInPhase={signInPhase} />}
      {!regions.showEmptyState && (
        <>
          {/* Missing only counts when no agent is set up: one of two is a choice. */}
          <AgentProblemLine agentId="claude" variant="home" showMissing={localReady && agents.length === 0} />
          <AgentProblemLine agentId="codex" variant="home" showMissing={localReady && agents.length === 0} />
        </>
      )}
      {/*
       * D6 fix: below `lg` (this app's own window can go as narrow as
       * 700px, well under the 1024px `lg` breakpoint — this is the COMMON
       * case, not an edge one), CSS `order` only changes VISUAL flex
       * position, never the underlying DOM order tab/keyboard navigation
       * and screen readers actually follow. The old markup had RigsRail
       * FIRST in the DOM with `order-2` (visually second, narrow) and
       * BriefingSpine second in the DOM with `order-1` (visually first,
       * narrow) — so Tab jumped to the rig list before the briefing even
       * though the briefing rendered above it. Inverted here: DOM order
       * now IS the narrow-viewport visual order (briefing and people, then
       * rigs) with no override needed for it, and `lg:order-*` ONLY
       * shifts rigs to the visual left at wide viewports — keyboard order
       * matches what's on screen at every width.
       */}
      {/*
       * Layout-air round (Dylan's screenshot): `gap-8` → `gap-10` between
       * the rails and the center column — a bit more separation now that
       * the rails carry their own surface too (`RigsRail`'s own `bg-1`
       * panel below), so the seam reads as two distinct
       * regions rather than one continuous strip. The center column adds
       * `lg:pl-2` of its own so the seam is the board's 48px.
       */}
      {/* Spaced across: 64px from the window's left edge to the Spaces card, 80px to the main section, 96px to the right edge.
          From 1400px (in rem, so it sorts after `lg`), People is a column on the right: 96px from the main section, 64px
          from the edge, mirroring the left. */}
      <div className="flex min-h-0 flex-1 flex-col gap-8 lg:flex-row lg:items-start lg:gap-20">
        {showPulse && (
          <div className="min-w-0 flex-1 lg:order-2" data-testid="home-center">
            {/*
             * The center column, 80px from the Spaces card: the greeting,
             * the summary, Ask and its chips, then Waiting on you, the
             * topics and People, 20px apart.
             */}
            <div className="flex w-full flex-col gap-5">
              <BriefingSpine
                localRigs={localRigs}
                onOpenPath={onOpenPath}
                onHighlightRig={setHighlightBindingId}
                askChips={askChips}
              />
              {/* Waiting on you: direct, unread things, each with its one action. */}
              <WaitingOnYouSection
                spaceRows={spaceRows}
                statusByBinding={connectionDown ? new Map() : statusByBinding}
                selfUserId={selfUserId}
                self={meQuery.data?.success ? meQuery.data.data : null}
                avatarOf={({ userId, name }) =>
                  (userId ? yourPeople.find((p) => p.userId === userId || p.clerkUserId === userId)?.avatarUrl : null) ??
                  avatarOf(name)
                }
                onOpenPath={(path) => onOpenPath(path, { kind: 'space' })}
              />
              {spacesEnabled && (
                <AcrossYourSpacesToday
                  view={acrossView}
                  onOpenTheme={(theme) => openSpaceOnTheme(theme.bindingId, theme.themeId)}
                  avatarOf={avatarOf}
                  marks={topicMarks}
                  reasonsOf={(bindingId) => facesByBinding.get(bindingId) ?? []}
                />
              )}
              <PeopleRail lastActivity={lastActivity} className="min-[87.5rem]:hidden" />
            </div>
          </div>
        )}
        {showPulse && (
          <PeopleRail
            lastActivity={lastActivity}
            className="hidden w-[280px] shrink-0 min-[87.5rem]:order-3 min-[87.5rem]:ml-4 min-[87.5rem]:flex"
          />
        )}
        <div
          className={cn(
            'flex w-full flex-col gap-4 lg:order-1',
            // Solo/signed-out: no pulse regions beside it — a fixed-width
            // rail would leave a wide window mostly empty, so the left
            // column becomes its own wider, centered column instead of a
            // cramped sidebar with nothing next to it.
            // Narrower beside the People column, so the center keeps its share.
            showPulse ? 'lg:w-[340px] lg:shrink-0 xl:w-[360px] min-[87.5rem]:w-[300px]' : 'mx-auto lg:max-w-2xl'
          )}
        >
          {spacesEnabled && signedIn && (
            <>
              {/* Quick-create, floating above the Spaces card: "New space", or its link bubble to join one. */}
              <NewSpaceCta
                existingNames={spaceNames}
                onCreateSpace={createSpace}
                onOpenPath={onOpenPath}
                needsConnection={connectionDown}
              />
              <SpacesCard
                rows={spaceRows}
                settingUp={settingUpSpaces}
                onOpenSetup={requestOpenSetup}
                statusByBinding={statusByBinding}
                selfUserId={selfUserId}
                topicByBinding={topicByBinding}
                // Opened as a space even while the relay can't confirm its kind.
                onOpenPath={(path) => onOpenPath(path, { kind: 'space' })}
                highlightBindingId={highlightBindingId}
                facesByBinding={facesByBinding}
                offline={connectionDown}
                offlineActivity={offlineActivity}
                emptyHint={
                  rowWorkspaces.status === 'loading'
                    ? 'Loading your spaces…'
                    : connectionDown
                      ? 'Your spaces show here once rig is reachable.'
                      : undefined
                }
              />
            </>
          )}
          {/* Plain rigs are hidden while spaces are on, unless Settings › Spaces shows them. */}
          {!rigsHidden && (
            <FloatingCard
              storageKey="rig-home-solo-rigs-collapsed"
              title="Rigs"
              count={soloRigRows.length}
              headerAction={
                // A new rig syncs from the start, so it needs the relay too.
                <NeedsConnection blocked={connectionDown}>
                  <button
                    type="button"
                    onClick={startFreshOrCreate}
                    disabled={connectionDown}
                    className="bg-bg-2 text-text-muted hover:text-text-primary flex items-center gap-1 rounded-chip px-2 py-0.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Plus className="size-3 shrink-0" strokeWidth={1.5} />
                    New
                  </button>
                </NeedsConnection>
              }
            >
              <RigsRail
                rows={soloRigRows}
                identities={identities}
                onOpenPath={onOpenPath}
                onOpenSession={onContinueSession}
                highlightBindingId={highlightBindingId}
              />
            </FloatingCard>
          )}
        </div>
      </div>
    </div>
  );
}

/** Start fresh failed with nothing more specific to say. */
const START_FRESH_FAILED = "Rig couldn't start your space. Try again.";

/**
 * First run (docs/onboarding-flow-spec.md §1) — no rigs anywhere yet, for
 * anyone (local or shared). Exactly one primary action, per the spec's
 * "one action" principle: no secondary links, no provider setup, no health
 * line. Sync and Google-Doc import stay reachable later (Share, the file
 * navigator) — never here.
 *
 * Sign-in is the one exception (Decisions, "Sign-in on Start fresh"): a
 * signed-out click runs the existing browser round-trip before creating, so
 * this component is thin over `welcome-state.ts`'s `deriveWelcomePhase` —
 * it only maps a phase to copy/disabled, `home.tsx` owns every transition.
 * `authLoading` is passed separately from `phase` on purpose: while auth
 * status is still in flight the phase stays `'idle'` (no copy change, per
 * spec), but the button must still be momentarily disabled so a signed-out
 * guess never flashes as a clickable "Start fresh" for a signed-in user.
 */
export function Welcome({
  phase,
  authLoading,
  onStartFresh,
  needsConnection,
  signInUrl = null,
  onCancelSignIn,
  signInOnly,
  children,
}: {
  phase: WelcomePhase;
  authLoading: boolean;
  onStartFresh: () => void;
  needsConnection: boolean;
  /** The sign-in page's address while waiting, to open or copy by hand. */
  signInUrl?: string | null;
  /** Stops waiting for sign-in, back to Start fresh. */
  onCancelSignIn?: () => void;
  /** Signed out: a plain Sign in that makes nothing, for someone who came for an invite. */
  signInOnly?: { onSignIn: () => void; phase: RigSignInPhase; url: string | null; onCancel: () => void };
  /** Under it all: the invite link field. */
  children?: ReactNode;
}) {
  const signingInOnly = signInOnly && signInOnly.phase !== 'idle';
  const waiting = phase.kind === 'signingIn' || phase.kind === 'creating' || !!signingInOnly;
  // An error leaves the button clickable, to try again.
  const disabled = waiting || authLoading || needsConnection;
  const label =
    phase.kind === 'signingIn' ? 'Waiting for sign-in…' : phase.kind === 'creating' ? 'Starting…' : 'Start fresh';
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
      <RigAppIcon size={112} className="shadow-soft" />
      <p className="font-display text-text-primary text-xl">
        Collaborate with your agents, and everyone else&rsquo;s.
      </p>
      <NeedsConnection blocked={needsConnection && !waiting}>
        <button
          type="button"
          onClick={onStartFresh}
          disabled={disabled}
          className="welcome-cta bg-accent text-accent-ink focus-visible:outline-accent inline-flex items-center gap-2 rounded-chip px-6 py-3 text-base font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60"
        >
          {waiting && <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />}
          {label}
        </button>
      </NeedsConnection>
      {phase.kind === 'signingIn' && (
        <SignInWaiting url={signInUrl} onCancel={onCancelSignIn} note="Sign in to start." />
      )}
      {phase.kind === 'error' && <p className="text-danger text-xs">{phase.message}</p>}
      {signingInOnly ? (
        <SignInWaiting url={signInOnly.url} onCancel={signInOnly.onCancel} />
      ) : (
        signInOnly &&
        phase.kind !== 'signingIn' && (
          <p className="text-text-muted text-sm">
            Have an account or an invite?{' '}
            <button
              type="button"
              onClick={signInOnly.onSignIn}
              disabled={needsConnection || phase.kind === 'creating'}
              className="text-accent hover:opacity-80 disabled:pointer-events-none disabled:opacity-50"
              data-testid="welcome-sign-in"
            >
              Sign in
            </button>
          </p>
        )
      )}
      {children}
    </div>
  );
}

/**
 * Feedback round, Part A — the ONLY thing Home renders while signed out
 * (docs/onboarding-flow-spec.md's "Accounts & rigs": files are yours,
 * memberships are per account, so a signed-out window has no account to
 * show rigs FOR). Deliberately as thin as `Welcome` itself — same icon,
 * same `.welcome-cta` button styling — but a different verb: this never
 * creates anything, it only runs the same `useRigSignIn` round-trip the
 * topbar's own sign-in affordance uses. Once sign-in lands, `authQuery`/
 * `signedIn` flip and `home.tsx` re-renders past this gate on its own — no
 * local phase to track here beyond `signInPhase` itself.
 */
export function SignedOutGate({
  signInPhase,
  onSignIn,
  expired = false,
  signInUrl = null,
  onCancel,
}: {
  signInPhase: RigSignInPhase;
  onSignIn: () => void;
  /** The stored sign-in was refused (expired or revoked): say so, not a fresh-install greeting. */
  expired?: boolean;
  /** The sign-in page's address while waiting, to open or copy by hand. */
  signInUrl?: string | null;
  /** Stops waiting for sign-in. */
  onCancel?: () => void;
}) {
  const waiting = signInPhase !== 'idle';
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
      <RigAppIcon size={112} className="shadow-soft" />
      <div className="flex flex-col gap-2">
        <p className="font-display text-text-primary text-xl">
          {expired ? 'Your sign-in has expired' : 'Sign in to see your rigs'}
        </p>
        {expired && <p className="text-text-muted text-sm">Sign in again to pick up where you left off.</p>}
      </div>
      <button
        type="button"
        onClick={() => void onSignIn()}
        disabled={waiting}
        className="welcome-cta bg-accent text-accent-ink focus-visible:outline-accent inline-flex items-center gap-2 rounded-chip px-6 py-3 text-base font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60"
      >
        {waiting && <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />}
        {waiting ? 'Waiting for sign-in…' : 'Sign in'}
      </button>
      {waiting && <SignInWaiting url={signInUrl} onCancel={onCancel} />}
    </div>
  );
}

/**
 * Under a "Waiting for sign-in…" button: the link to open by hand when the
 * browser tab closed or never opened, and Cancel to stop waiting.
 */
function SignInWaiting({ url, onCancel, note }: { url: string | null; onCancel?: () => void; note?: string }) {
  return (
    <div className="flex w-full flex-col items-center gap-3" data-testid="sign-in-waiting">
      {note && <p className="text-text-muted text-xs">{note}</p>}
      {url && <ManualLink url={url} />}
      {onCancel && (
        <Button variant="ghost" size="sm" onClick={onCancel} data-testid="sign-in-cancel">
          Cancel
        </Button>
      )}
    </div>
  );
}

/**
 * The shipped app icon (`src/assets/images/rig/rig-icon.svg`, baked into
 * `rig.icns`/`rig.png` for the bundle and Dock) — inlined the same way as
 * `RigMark` (`@renderer/lib/ui/rig-mark`, the bare glyph used for agent
 * identity elsewhere) rather than imported as a file: nothing in this
 * renderer imports static assets from `src/assets/` today, and inlining
 * keeps this a self-contained, zero-risk change. Colors are the shipped
 * asset's own fixed palette, not theme tokens — an app icon reads the same
 * regardless of the app's light/dark theme, same as the Dock icon it
 * mirrors.
 */
function RigAppIcon({ size = 112, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="none"
      className={className}
      aria-hidden
    >
      <rect x="100" y="100" width="824" height="824" rx="184" ry="184" fill="#09090B" />
      <rect
        x="100.5"
        y="100.5"
        width="823"
        height="823"
        rx="183.5"
        ry="183.5"
        fill="none"
        stroke="#27272A"
        strokeWidth="1"
      />
      <g transform="translate(277, 277) scale(1.8359)">
        <path d="M 256 256 L 128 256 L 0 128 L 128 128 Z M 256 128 L 128 128 L 0 0 L 128 0 Z" fill="#D4D4D8" />
      </g>
    </svg>
  );
}

/**
 * One quiet mono line above the grid — no dashboard chrome, just the
 * honest current mode. Only `signedOut` is actionable (runs the same
 * `useRigSignIn` flow the topbar pill does); `noAgent` is stated once, not
 * clickable. Connection trouble is `ConnectionBanner`'s, not this line's.
 */
function HealthLine({
  message,
  onSignIn,
  signInPhase,
}: {
  message: HomeHealthMessage;
  onSignIn: () => void;
  signInPhase: RigSignInPhase;
}) {
  if (message.kind === 'signedOut') {
    return (
      <button
        type="button"
        onClick={() => void onSignIn()}
        disabled={signInPhase !== 'idle'}
        className="text-text-muted hover:text-text-primary flex items-center gap-1.5 self-start font-mono text-xs transition-colors disabled:pointer-events-none disabled:opacity-60"
      >
        <LogIn className="size-3 shrink-0" strokeWidth={1.5} />
        {signInPhase === 'idle' ? message.text : 'Waiting for sign-in…'}
      </button>
    );
  }
  // Each agent's own line below says what to install.
  return (
    <div className="text-text-muted flex items-center gap-2 self-start font-mono text-xs" data-testid="home-no-agent">
      {message.text}
    </div>
  );
}

