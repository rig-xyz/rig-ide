import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, LogIn } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentIdentities, useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { useRigSignIn, type RigSignInPhase } from '@renderer/features/rig-account/use-rig-sign-in';
import {
  MY_INVITES_KEY_PREFIX,
  myInvitesQueryKey,
  shapeMyInvites,
  type MyInviteRow,
} from '@renderer/features/shell/invites-inbox';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { cn } from '@renderer/lib/utils';
import { BriefingSpine } from './briefing-spine';
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
import { PeopleRail } from './people-rail';
import { shouldShowPulseSection } from './pulse-state';
import { RigsRail } from './rigs-rail';
import { deriveWelcomePhase, type WelcomePhase } from './welcome-state';

/**
 * Round: HOME RESTRUCTURE — Dylan-approved IA, structurally referencing
 * the web hub home (`hub/web`'s `app/home/page.tsx`: sidebar/center/rail),
 * restyled to this app's own tokens rather than copied. Three regions:
 *
 *   LEFT   — `RigsRail`, the action zone: ONE rig-centric list (kills the
 *            old separate CONTINUE + RIGS sections and the mid-page "Open
 *            a rig" hero — the true empty state below is now the first-run
 *            `Welcome` screen instead, see onboarding-flow-spec.md).
 *   CENTER — `BriefingSpine`, the pulse briefing (kicker, greeting,
 *            summary, ask, WHAT'S NEW).
 *   RIGHT  — `PeopleRail`, per-person pulse lines. Absent (no chrome) when
 *            there's no one to show.
 *
 * `showPulse` (`shouldShowPulseSection`, UNCHANGED semantics) gates the
 * center/right regions together — signed-out and "solo" (no relay
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
  onOpenPath: (path: string) => void;
  onContinueSession: (path: string, sessionId: string) => void;
  /**
   * Onboarding flow round (docs/onboarding-flow-spec.md §2): fires once the
   * one-click create (Welcome's "Start fresh", or the rail's "New rig")
   * actually created a rig — `App.tsx` opens it and arms the topbar's
   * inline auto-rename and the landing-doc open.
   */
  onRigCreated: (path: string, docPath: string | null) => void;
}) {
  const { agents, isLoading: agentsLoading } = useRunnableAgents();
  const identities = useAgentIdentities();
  const queryClient = useQueryClient();
  // Re-entrancy guard, not React state — a second click while the first
  // create is still in flight should just no-op, not start a second rig.
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);

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
    try {
      const result = await rpc.rig.create.create({
        parentDir: null,
        name: 'Untitled rig',
        sync: true,
        seedDoc: true,
      });
      if (!result.success) return; // best-effort — no dialog left to surface the error in
      if (result.data.rootId) void rpc.rig.files.releaseRoot({ rootId: result.data.rootId });
      void queryClient.invalidateQueries({ queryKey: ['rig', 'recent'] });
      void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
      onRigCreated(result.data.path, result.data.docPath);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [queryClient, onRigCreated]);
  // Pulse round: which rigs-rail row a WHAT'S NEW/ACROSS YOUR RIGS rig-name
  // link (no local match) should scroll to/flash — lives here, not in
  // either `BriefingSpine` or `RigsRail` alone, since it's the one piece of
  // state that crosses between them (center → left).
  const [highlightBindingId, setHighlightBindingId] = useState<string | null>(null);

  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = authQuery.data?.signedIn ?? false;

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
  } = useRigSignIn(() => void createRig());

  const startFreshOrCreate = useCallback(() => {
    if (signedIn) {
      void createRig();
    } else {
      void signInThenCreateRig();
    }
  }, [signedIn, createRig, signInThenCreateRig]);

  const welcomePhase: WelcomePhase = deriveWelcomePhase({
    authLoading: authQuery.isLoading,
    signedIn,
    signInPhase: createSignInPhase,
    signInError: createSignInError,
    creating,
  });

  const workspacesQuery = useQuery({
    queryKey: ['rig', 'account', 'workspaces'],
    queryFn: () => rpc.rig.account.workspaces(),
    enabled: signedIn,
  });

  // Accounts & rigs round: same query key `user-pill.tsx` already uses for
  // the topbar identity pill, so this shares that cache/subscription
  // rather than firing a second `/v1/me` — only the rail's own account
  // filter (`filterLocalRigsByAccount` below) reads it here.
  const meQuery = useQuery({
    queryKey: ['rig', 'account', 'me'],
    queryFn: () => rpc.rig.account.me(),
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

  const { signIn, phase: signInPhase } = useRigSignIn();

  const localReady = !agentsLoading && !localRigsQuery.isLoading && !recentSessionsQuery.isLoading;

  // Accounts & rigs round: `undefined` while signed in but `meQuery` hasn't
  // resolved yet (never filter on a guess), `null` once confidently signed
  // out, else the signed-in account's own id — see
  // `filterLocalRigsByAccount`'s own doc comment for what each does below.
  const currentAccountId: string | null | undefined = !signedIn
    ? null
    : meQuery.data?.success
      ? meQuery.data.data.id
      : undefined;

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
  const pendingInvite: MyInviteRow | null = myInvitesQuery.data?.success
    ? (shapeMyInvites(myInvitesQuery.data.data.invites)[0] ?? null)
    : null;

  const workspaces = deriveWorkspacesState(signedIn, {
    isLoading: workspacesQuery.isLoading,
    data: workspacesQuery.data,
  });

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
    workspaces.status === 'ok'
      ? [...workspaces.bindings]
          .map((b) => b.bindingId)
          .sort()
          .join(',')
      : '';
  const ownedBindingIds = useMemo(
    () => new Set(ownedBindingIdsKey ? ownedBindingIdsKey.split(',') : []),
    [ownedBindingIdsKey]
  );
  const legacyVisibility: LegacyRowVisibility =
    workspaces.status === 'ok' ? { kind: 'ownedOnly', bindingIds: ownedBindingIds } : { kind: 'showAll' };

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
    workspaces.status === 'ok'
      ? workspaces.bindings.map((b) => b.bindingId).filter((id) => !localBindingIds.has(id))
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
    ? deriveHomeRegions({ signedIn, hasRunnableAgent: agents.length > 0, localRigs, recentSessions, workspaces })
    : { showRigs: false, showEmptyState: true, health: null };

  const rigRows = regions.showRigs
    ? buildHomeRigRows(localRigs, workspaces, recentSessions, localPaths, localPathsPending)
    : [];

  const showPulse = shouldShowPulseSection(
    signedIn,
    workspaces.status === 'ok'
      ? { status: 'ok', bindingCount: workspaces.bindings.length }
      : { status: workspaces.status }
  );

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
        <SignedOutGate signInPhase={signInPhase} onSignIn={signIn} />
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
        <Welcome phase={welcomePhase} authLoading={authQuery.isLoading} onStartFresh={startFreshOrCreate} />
        {pendingInvite && <PendingInviteInline invite={pendingInvite} onOpenPath={onOpenPath} />}
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
    // Glow v4: anchored to this panel's own top edge (under the topbar
    // hairline), where a wash starting at full intensity reads as chrome —
    // floating mid-content it read as a cut-off box. Ellipse radii sized so
    // alpha hits zero before either horizontal edge. Padding widened per
    // Dylan: the column was crowding the rail.
    <div className="hero-glow flex min-h-full w-full flex-col gap-4 px-10 pt-4 pb-8">
      {regions.health && <HealthLine message={regions.health} onSignIn={signIn} signInPhase={signInPhase} />}
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
       * now IS the narrow-viewport visual order (briefing, then rigs, then
       * people) with no override needed for it, and `lg:order-*` ONLY
       * shifts rigs to the visual left at wide viewports — keyboard order
       * matches what's on screen at every width.
       */}
      {/*
       * Layout-air round (Dylan's screenshot): `gap-8` → `gap-10` between
       * the rails and the center column — a bit more separation now that
       * the rails carry their own surface too (`RigsRail`/`PeopleRail`'s
       * own `bg-1` panels below), so the seam reads as two distinct
       * regions rather than one continuous strip. `lg:px-4` on the
       * center column is new too — it had NONE of its own before,
       * relying entirely on the row's `gap` for breathing room.
       */}
      <div className="flex min-h-0 flex-1 flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
        {showPulse && (
          <div className="min-w-0 flex-1 lg:order-2 lg:px-4">
            <BriefingSpine
              localRigs={localRigs}
              onOpenPath={onOpenPath}
              onHighlightRig={setHighlightBindingId}
            />
          </div>
        )}
        <div
          className={cn(
            'w-full lg:order-1',
            // Solo/signed-out: no pulse regions beside it — a fixed 280px
            // rail would leave a wide window mostly empty, so the rigs
            // list becomes its own wider, centered column instead of a
            // cramped sidebar with nothing next to it.
            showPulse ? 'lg:w-[280px] lg:shrink-0' : 'mx-auto lg:max-w-2xl'
          )}
        >
          <RigsRail
            rows={rigRows}
            identities={identities}
            onOpenPath={onOpenPath}
            onOpenSession={onContinueSession}
            onOpenFolder={onOpenFolder}
            onCreateRig={startFreshOrCreate}
            highlightBindingId={highlightBindingId}
          />
        </div>
        {showPulse && (
          <div className="hidden xl:order-3 xl:block xl:w-[300px] xl:shrink-0">
            <PeopleRail />
          </div>
        )}
      </div>
    </div>
  );
}

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
function Welcome({
  phase,
  authLoading,
  onStartFresh,
}: {
  phase: WelcomePhase;
  authLoading: boolean;
  onStartFresh: () => void;
}) {
  const disabled = phase.kind !== 'idle' || authLoading;
  const waiting = phase.kind === 'signingIn' || phase.kind === 'creating';
  const label =
    phase.kind === 'signingIn' ? 'Waiting for sign-in…' : phase.kind === 'creating' ? 'Starting…' : 'Start fresh';
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
      <RigAppIcon size={112} className="shadow-soft" />
      <p className="font-display text-text-primary text-xl">
        Collaborate with your agents, and everyone else&rsquo;s.
      </p>
      <button
        type="button"
        onClick={onStartFresh}
        disabled={disabled}
        className="welcome-cta bg-accent text-accent-ink focus-visible:outline-accent inline-flex items-center gap-2 rounded-chip px-6 py-3 text-base font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60"
      >
        {waiting && <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />}
        {label}
      </button>
      {phase.kind === 'signingIn' && (
        <p className="text-text-muted text-xs">Rig is collaborative — sign in to start.</p>
      )}
      {phase.kind === 'error' && <p className="text-danger text-xs">{phase.message}</p>}
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
function SignedOutGate({ signInPhase, onSignIn }: { signInPhase: RigSignInPhase; onSignIn: () => void }) {
  const waiting = signInPhase !== 'idle';
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-8 text-center">
      <RigAppIcon size={112} className="shadow-soft" />
      <p className="font-display text-text-primary text-xl">Sign in to see your rigs</p>
      <button
        type="button"
        onClick={() => void onSignIn()}
        disabled={waiting}
        className="welcome-cta bg-accent text-accent-ink focus-visible:outline-accent inline-flex items-center gap-2 rounded-chip px-6 py-3 text-base font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60"
      >
        {waiting && <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />}
        {waiting ? 'Waiting for sign-in…' : 'Sign in'}
      </button>
    </div>
  );
}

/**
 * Feedback round, Part C — an account with zero rigs but a pending invite
 * gets it surfaced right on the empty state, not only behind the topbar
 * bell (`invites-bell.tsx`'s `InviteRow`). Deliberately does NOT replay
 * that row's own two-step accept/"Set up locally" flow: with nothing else
 * on screen, one click doing accept-then-attach end to end is the more
 * honest "one line + one button" than a second interstitial state would
 * be. Mirrors `InviteRow`'s two relay calls exactly (`acceptMyInvite` then
 * `join.attach`) — a failure in the SECOND one still leaves the invite
 * accepted server-side, so this quietly falls back to idle rather than
 * showing an error; the `['rig','account']` invalidate below means the
 * next render already knows about the binding either way (it'll show as
 * relay-only in the rail once `regions.showEmptyState` flips).
 */
function PendingInviteInline({
  invite,
  onOpenPath,
}: {
  invite: MyInviteRow;
  onOpenPath: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'working' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setPhase('working');
    setError(null);
    const accepted = await rpc.rig.share.acceptMyInvite({ id: invite.id });
    if (!accepted.success) {
      setPhase('error');
      setError(accepted.error.message);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
    void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
    const attached = await rpc.rig.join.attach({ bindingId: invite.bindingId });
    if (!attached.success) {
      setPhase('idle');
      return;
    }
    markJustAttachedSyncing(attached.data.localPath, attached.data.syncing);
    onOpenPath(attached.data.localPath);
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <p className="text-text-muted text-sm">
        {invite.inviterLabel} invited you to {invite.rigName} ·{' '}
        <button
          type="button"
          onClick={() => void accept()}
          disabled={phase === 'working'}
          className="text-accent hover:opacity-80 disabled:pointer-events-none disabled:opacity-50"
        >
          {phase === 'working' ? 'Accepting…' : 'Accept'}
        </button>
      </p>
      {phase === 'error' && error && <p className="text-danger text-xs">{error}</p>}
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
 * `useRigSignIn` flow the topbar pill does); `noAgent`/`relayUnreachable`
 * are stated once, not clickable.
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
  return <p className="text-text-muted self-start font-mono text-xs">{message.text}</p>;
}
