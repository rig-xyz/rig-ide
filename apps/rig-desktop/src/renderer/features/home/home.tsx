import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useAgentIdentities, useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { useRigSignIn, type RigSignInPhase } from '@renderer/features/rig-account/use-rig-sign-in';
import { rpc } from '@renderer/lib/ipc';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { cn } from '@renderer/lib/utils';
import { BriefingSpine } from './briefing-spine';
import {
  buildHomeRigRows,
  deriveHomeRegions,
  deriveWorkspacesState,
  type HomeHealthMessage,
  type HomeLocalRig,
  type HomeRecentSession,
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

  const localRigs: HomeLocalRig[] = (localRigsQuery.data ?? []).map((r) => ({
    bindingId: r.bindingId,
    name: r.name,
    path: r.path,
    lastOpenedAt: r.lastOpenedAt,
    paused: r.paused,
    outsideHome: r.outsideHome,
  }));
  const recentSessions: HomeRecentSession[] = recentSessionsQuery.data ?? [];
  const workspaces = deriveWorkspacesState(signedIn, {
    isLoading: workspacesQuery.isLoading,
    data: workspacesQuery.data,
  });

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

  if (regions.showEmptyState) {
    // `min-h-full` (not `h-full`) + no overflow of its own — `main` (the
    // parent, in `App.tsx`) is what scrolls; matches round H2's own fix
    // for the classic flexbox-centering-clips-the-top bug.
    //
    // Onboarding flow round: this is now the ONLY first-run surface
    // (docs/onboarding-flow-spec.md §1) — no Open Folder…, no "ask your
    // agent", no dialog. One line, one button.
    return (
      <div className="flex min-h-full w-full items-center justify-center p-8">
        <Welcome phase={welcomePhase} authLoading={authQuery.isLoading} onStartFresh={startFreshOrCreate} />
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
  const label =
    phase.kind === 'signingIn' ? 'Waiting for sign-in…' : phase.kind === 'creating' ? 'Starting…' : 'Start fresh';
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
      <RigMark size={40} className="text-text-primary" />
      <p className="font-display text-text-primary text-lg">
        Collaborate with your agents, and everyone else&rsquo;s.
      </p>
      <button
        type="button"
        onClick={onStartFresh}
        disabled={disabled}
        className="bg-accent text-accent-ink rounded-control px-5 py-2 text-sm font-medium transition-colors hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
      >
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
