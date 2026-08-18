import { useQuery } from '@tanstack/react-query';
import { FolderOpen, LogIn, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useAgentIdentities, useRunnableAgents } from '@renderer/features/chat/use-runnable-agents';
import { useRigSignIn, type RigSignInPhase } from '@renderer/features/rig-account/use-rig-sign-in';
import { CreateRigDialog } from '@renderer/features/rig-create/create-rig-dialog';
import { rpc } from '@renderer/lib/ipc';
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

/**
 * Round: HOME RESTRUCTURE — Dylan-approved IA, structurally referencing
 * the web hub home (`hub/web`'s `app/home/page.tsx`: sidebar/center/rail),
 * restyled to this app's own tokens rather than copied. Three regions:
 *
 *   LEFT   — `RigsRail`, the action zone: ONE rig-centric list (kills the
 *            old separate CONTINUE + RIGS sections and the mid-page "Open
 *            a rig" hero — the hero survives ONLY in the true empty state,
 *            below).
 *   CENTER — `BriefingSpine`, the pulse briefing (kicker, greeting,
 *            summary, ask, WHAT'S NEW).
 *   RIGHT  — `PeopleRail`, per-person pulse lines. Absent (no chrome) when
 *            there's no one to show.
 *
 * `showPulse` (`shouldShowPulseSection`, UNCHANGED semantics) gates the
 * center/right regions together — signed-out and "solo" (no relay
 * bindings) render the rigs rail alone, which works standalone by design.
 * The true empty state (no rigs anywhere) pre-empts everything else: just
 * the icon/title/Open-Folder hero, same as before this round.
 */
export function Home({
  onOpenFolder,
  onOpenPath,
  onContinueSession,
}: {
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onContinueSession: (path: string, sessionId: string) => void;
}) {
  const { agents, isLoading: agentsLoading } = useRunnableAgents();
  const identities = useAgentIdentities();
  const [createOpen, setCreateOpen] = useState(false);
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
    return (
      <div className="flex min-h-full w-full items-center justify-center p-8">
        <EmptyHero
          agentReady={agents.length > 0}
          onOpenFolder={onOpenFolder}
          onCreateRig={() => setCreateOpen(true)}
        />
        <CreateRigDialog open={createOpen} onOpenChange={setCreateOpen} onOpenPath={onOpenPath} />
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
    <div className="flex min-h-full w-full flex-col gap-4 px-6 pt-3 pb-6">
      {regions.health && <HealthLine message={regions.health} onSignIn={signIn} signInPhase={signInPhase} />}
      <CreateRigDialog open={createOpen} onOpenChange={setCreateOpen} onOpenPath={onOpenPath} />
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
            onCreateRig={() => setCreateOpen(true)}
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
 * The true empty state — no rigs anywhere, for anyone (local or shared).
 * The ONLY place the old bare "Open a rig" hero survives: icon, title,
 * Open Folder + New rig side by side (create-a-rig round), and (an agent
 * is ready but there's nothing to point it at yet) the "ask your agent"
 * close.
 */
function EmptyHero({
  agentReady,
  onOpenFolder,
  onCreateRig,
}: {
  agentReady: boolean;
  onOpenFolder: () => void;
  onCreateRig: () => void;
}) {
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
      <FolderOpen size={32} strokeWidth={1.5} className="text-text-muted" />
      <h1 className="font-display text-text-primary text-xl">Open a rig</h1>
      {agentReady && (
        <button
          type="button"
          onClick={onOpenFolder}
          className="text-text-muted hover:text-text-primary flex items-center gap-1.5 text-xs transition-colors"
        >
          <Sparkles className="size-3.5 shrink-0" strokeWidth={1.5} />
          Ask your agent to set up a rig
        </button>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenFolder}
          className="bg-accent text-accent-ink rounded-control px-4 py-2 text-sm font-medium transition-colors hover:opacity-90"
        >
          Open Folder…
        </button>
        <button
          type="button"
          onClick={onCreateRig}
          className="border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex items-center gap-1.5 border px-4 py-2 text-sm transition-colors"
        >
          <Plus className="size-4 shrink-0" strokeWidth={1.5} />
          New rig
        </button>
      </div>
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
