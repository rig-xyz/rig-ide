import { useQuery, useQueryClient } from '@tanstack/react-query';
import { tailMode } from '@emdash/chat-ui';
import type { ChatCommands, ChatView } from '@renderer/lib/chat/chat-transcript';
import { ChatTranscript } from '@renderer/lib/chat/chat-transcript';
import { rpc } from '@renderer/lib/ipc';
import { AgentIcon } from '@renderer/lib/ui/agent-icon';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import type { RigFileNode } from '@shared/rig/files';
import { classifyProseLink } from './classify-prose-link';
import {
  Check,
  History,
  MessageSquare,
  PanelLeftClose,
  Pencil,
  Play,
  Plus,
  Send,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { events } from '@renderer/lib/ipc';
import {
  rigSettingsChangedChannel,
  type RigOpenTabsState,
  type RigSettings,
} from '@shared/rig/settings';
import type { RigStoredSession } from '@shared/rig/sessions';
import { deriveComposerDensity, type ComposerDensity } from './composer-density';
import { deriveDefaultHarness } from './default-harness';
import { canResumeSession } from './resume-capability';
import { deriveTranscriptPanelMode, shouldShowResumeButton } from './resume-presentation';
import { formatSessionFromLabel, relativeTime } from './session-history';
import { HarnessPicker } from './harness-picker';
import { MetaOptionPicker } from './meta-option-picker';
import { PermissionModePicker } from './permission-mode-picker';
import { ReplayStore } from './replay-store';
import { RigChatStore } from './rig-chat-store';
import {
  addSession,
  byRecency,
  closeTab,
  deriveTabTitle,
  removeSession,
  type RigSessionSummary,
} from './session-list';
import { openTabsStateEquals, toOpenTabsState } from './tab-restore';
import {
  useAgentIdentities,
  useRunnableAgents,
  type AgentIdentity,
  type RunnableAgent,
} from './use-runnable-agents';

type RigSession = RigChatStore | ReplayStore;

/**
 * The chat panel: real ACP sessions against the opened rig's own folder,
 * presented editor-style — one row of tabs (harness icon + title, `+` and
 * collapse at the strip's own right edge). No separate identity header (the
 * active tab already carries that) and, per round 13, no separate
 * new-session screen either: the zero-state is a transcript-less composer.
 *
 * The composer is a cockpit (design-system.md rule 8), shared between the
 * zero-state and a live session rather than two different components — its
 * harness chip is the picker before a session exists and a read-only
 * identity once one does; typing and sending in the zero-state IS what
 * starts the session (see `startSession` below).
 */

export interface ChatPanelProps {
  /** Absolute path to the opened rig's workspace root — the session cwd. */
  root: string;
  /** The rig's binding id (opaque `projectId` label — see rig-chat-store.ts). */
  bindingId: string;
  /** The rig's own name, for the zero-state transcript's "New session in …" line. */
  name: string | null;
  /**
   * A specific `rig_sessions` id that should become the active tab on THIS
   * mount (round H1 — the home screen's CONTINUE row: "open that rig AND
   * make that session the active restored tab"). Folded into the normal
   * tab-restore read below rather than replacing it — this rig's other
   * previously-open tabs still come back, this one just also gets added
   * (if it wasn't already among them) and wins the active slot.
   */
  initialActiveSessionId?: string | null;
  onOpenFile?: (absPath: string) => void;
  onToggleCollapse: () => void;
}

export const ChatPanel = observer(function ChatPanel({
  root,
  bindingId,
  name,
  initialActiveSessionId,
  onOpenFile,
  onToggleCollapse,
}: ChatPanelProps) {
  const { agents, isLoading: agentsLoading } = useRunnableAgents();
  // Icon/name display, decoupled from `agents`' probe gate — see
  // `useAgentIdentities`'s own doc comment. `agents` stays the source for
  // anything about whether a session can actually be started right now.
  const identities = useAgentIdentities();
  const storesRef = useRef(new Map<string, RigSession>());
  const [sessions, setSessions] = useState<RigSessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [followUpIds, setFollowUpIds] = useState<Set<string>>(new Set());
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  // Composer overlap round: the same ResizeObserver that already tracks
  // height (for the transcript's bottom content padding) also reads width
  // now — `deriveComposerDensity` turns it into the bottom utility row's
  // degradation tier.
  const [composerWidth, setComposerWidth] = useState(0);
  // Which bindingId's restore has finished — the persist-effect below must
  // never write before this, or it could race the restore read and clobber
  // the very snapshot being restored from.
  const restoredForRef = useRef<string | null>(null);
  const lastWrittenRef = useRef<RigOpenTabsState | null>(null);
  // Round: eager session activation. A real, connecting `RigChatStore` for
  // the zero-state's currently-selected harness — created before any
  // message is typed, so model/effort options are already populated by
  // the time the composer's pickers would want to show them. Deliberately
  // NOT added to `sessions`/the tab strip until actually used
  // (`startSession` "promotes" it): the zero-state's own History list
  // (`ZeroStateTranscript`) stays visible and useful the whole time this is
  // connecting in the background, exactly as it does today.
  const [eagerStore, setEagerStore] = useState<RigChatStore | null>(null);
  const eagerPromotedRef = useRef(false);

  // ── Zero-state default harness (harness-default round) ────────────────────
  // The previous rule — first agent of the first non-empty probe snapshot,
  // committed forever — made the default a probe-order accident: codex's
  // ~40ms probe beats claude's ~1s one, so a session opened soon after boot
  // always defaulted to codex. The default is now a preference signal
  // (this rig's last harness → the global most-recent → probe order; see
  // `deriveDefaultHarness`), and it stays REVISABLE while the zero-state is
  // untouched: late probe results or settings re-derive it, and only an
  // explicit user pick (`manualPickRef`) or a started session pins it.
  const [rigSettings, setRigSettings] = useState<RigSettings | null>(null);
  const manualPickRef = useRef(false);
  useEffect(() => {
    let alive = true;
    rpc.rig.settings
      .get()
      .then((settings) => {
        if (alive) setRigSettings(settings);
      })
      .catch(() => {});
    const off = events.on(rigSettingsChangedChannel, setRigSettings);
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (activeId !== null || manualPickRef.current) return;
    if (rigSettings === null) return; // history unknown — don't commit a probe-order accident early
    const next = deriveDefaultHarness({
      runnable: agents.map((agent) => agent.id),
      lastKnownRunnable: rigSettings.lastKnownRunnableAgents,
      lastForRig: rigSettings.lastHarnessByRig[bindingId] ?? null,
      lastGlobal: rigSettings.lastHarness,
    });
    if (next !== null && next !== providerId) setProviderId(next);
  }, [agents, rigSettings, activeId, providerId, bindingId]);

  const pickProvider = useCallback((id: string) => {
    manualPickRef.current = true;
    setProviderId(id);
  }, []);

  // Only the CURRENTLY selected harness is ever eager-started (never
  // speculatively all of them) — this effect re-runs (tearing down the
  // stale one first, via its own cleanup below) the moment `providerId`
  // changes, and stops altogether the moment the zero-state stops being
  // active (a real tab got selected, or this session got promoted).
  useEffect(() => {
    if (activeId !== null || !providerId) return;
    // A6 fix: pin `providerId` the instant a real eager store exists for
    // it — treated as if the user had explicitly picked it, exactly like
    // `pickProvider` does. Before this, a DERIVED default (no explicit
    // pick yet) stayed revisable, and `agents` (the derivation effect's
    // own dependency, line ~159) changes identity every time a runnability
    // probe resolves — on a first-time rig with no MRU, `runnable[0]` could
    // flip to a different agent after this effect already created a live,
    // connecting session for the OLD one, tearing it down mid-flight via
    // this effect's own cleanup below. A later probe landing must still be
    // free to correct the choice for the NEXT rig/session, just never rip
    // one already in flight out from under the user — who can still switch
    // manually regardless.
    manualPickRef.current = true;
    const stores = storesRef.current;
    const id = crypto.randomUUID();
    const store = new RigChatStore(id, bindingId, root, providerId);
    stores.set(id, store);
    eagerPromotedRef.current = false;
    setEagerStore(store);
    void store.bootstrap();
    return () => {
      // Promotion (`startSession`) already moved this store into the real
      // tab strip — it must survive past this cleanup, not be torn down
      // the instant `activeId` stops being null because of the promotion
      // itself. Every OTHER path this cleanup fires on (provider changed,
      // an existing tab was selected instead, this rig closed) genuinely
      // means the eager session was never used — dispose it and release
      // its slot in `storesRef` too, so it's not double-disposed later.
      if (eagerPromotedRef.current) return;
      store.dispose();
      stores.delete(id);
      // Clear the state reference too (identity-checked — never clobber a
      // NEWER eager store some other effect run may already have set) so
      // no render can ever read model/effort/mode off an already-disposed
      // store, even for one frame.
      setEagerStore((current) => (current === store ? null : current));
    };
  }, [activeId, providerId, bindingId, root]);

  /**
   * "Tabs should just come back" (persistence-design.md Round D): a
   * different rig was opened, so this panel's sessions belong to the old
   * cwd — reset, then restore whatever tabs were open last time THIS rig
   * was, as read-only replay views (no worker sessions spawned just from a
   * tab being open — see `ReplayStore`). A session id that's gone (row
   * deleted) is silently skipped, never shown as a fake tab.
   */
  useEffect(() => {
    setSessions([]);
    setActiveId(null);
    setFollowUpIds(new Set());
    restoredForRef.current = null;
    lastWrittenRef.current = null;
    const stores = storesRef.current;
    let cancelled = false;

    void (async () => {
      let stored: RigOpenTabsState | undefined;
      try {
        stored = (await rpc.rig.settings.get()).lastOpenTabsByRig[bindingId];
      } catch (error) {
        console.error('Rig chat: failed to read stored open tabs', { bindingId, error });
      }
      if (cancelled) return;

      // The home screen's "open this rig AND land on this session" target
      // (see `ChatPanelProps.initialActiveSessionId`) — folded into the
      // restored id set (deduped) rather than replacing it, so this rig's
      // other previously-open tabs still come back too.
      const idsToRestore = new Set(stored?.sessionIds ?? []);
      if (initialActiveSessionId) idsToRestore.add(initialActiveSessionId);

      if (idsToRestore.size === 0) {
        restoredForRef.current = bindingId;
        return;
      }

      const restored: RigSessionSummary[] = [];
      for (const sessionId of idsToRestore) {
        if (cancelled) return;
        let session: RigStoredSession | null = null;
        try {
          session = await rpc.rig.sessions.getSession({ sessionId });
        } catch (error) {
          console.error('Rig chat: failed to load a restored session', { sessionId, error });
        }
        if (!session) continue;
        const replay = new ReplayStore(sessionId);
        storesRef.current.set(sessionId, replay);
        void replay.load();
        restored.push({
          conversationId: sessionId,
          providerId: session.providerId,
          createdAt: session.createdAt,
          kind: 'replay',
        });
      }
      if (cancelled) return;
      setSessions(restored);
      setActiveId(
        initialActiveSessionId && restored.some((s) => s.conversationId === initialActiveSessionId)
          ? initialActiveSessionId
          : stored?.activeId && restored.some((s) => s.conversationId === stored!.activeId)
            ? stored.activeId
            : null
      );
      restoredForRef.current = bindingId;
    })();

    return () => {
      cancelled = true;
      stores.forEach((store) => store.dispose());
      stores.clear();
    };
    // `initialActiveSessionId` is a real dependency, not suppressed — but in
    // practice it only ever changes in lockstep with `bindingId` (App.tsx
    // sets it right before the `openPath` call that eventually produces a
    // new `bindingId`, and resets it on every subsequent `openPath` call,
    // targeted or not — see its own doc comment there), so this never
    // double-fires the restore for one mount.
  }, [root, bindingId, initialActiveSessionId]);

  // Persists on every open/close/switch — after this rig's own restore has
  // finished (see above) and only when the snapshot actually changed.
  useEffect(() => {
    if (restoredForRef.current !== bindingId) return;
    const next = toOpenTabsState(
      sessions.map((s) => s.conversationId),
      activeId
    );
    if (lastWrittenRef.current && openTabsStateEquals(lastWrittenRef.current, next)) return;
    lastWrittenRef.current = next;
    void rpc.rig.settings.set({ lastOpenTabsByRig: { [bindingId]: next } }).catch((error: unknown) => {
      console.error('Rig chat: failed to persist open tabs', { bindingId, error });
    });
  }, [sessions, activeId, bindingId]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const observerInstance = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setComposerHeight(rect.height);
      setComposerWidth(rect.width);
    });
    observerInstance.observe(el);
    return () => observerInstance.disconnect();
  }, []);

  /**
   * Typing + Send in the zero-state starts the session — make it the
   * active tab immediately (so the switch feels instant), then once the
   * runtime session actually exists, send the typed text as the real
   * first prompt — not a prefill. `submitPrompt` derives the tab title
   * from it the same way it already does for every later message.
   *
   * Round: eager session activation — if a matching eager store is
   * already connecting for this exact provider (the common case: eager
   * start had a head start on typing), this PROMOTES it rather than
   * creating a second, redundant one — `bootstrap()` is idempotent, so
   * awaiting it again just returns the already in-flight/settled promise.
   * Falls back to creating fresh when there isn't one (a race where eager
   * start's own effect hasn't landed yet, or `providerId` changed after
   * the last render).
   */
  const startSession = useCallback(
    (initialText: string) => {
      if (!providerId) return;
      // The one moment a harness choice becomes a real preference signal:
      // a session actually started with it. Feeds both the per-rig default
      // and the global fallback a brand-new rig inherits.
      void rpc.rig.settings.set({
        lastHarness: providerId,
        lastHarnessByRig: { [bindingId]: providerId },
      });
      if (eagerStore && eagerStore.providerId === providerId) {
        eagerPromotedRef.current = true;
        const store = eagerStore;
        setSessions((prev) =>
          addSession(prev, {
            conversationId: store.conversationId,
            providerId,
            createdAt: Date.now(),
            kind: 'live',
          })
        );
        setActiveId(store.conversationId);
        setEagerStore(null);
        void store.bootstrap().then(() => {
          if (!store.loadError) store.submitPrompt(initialText);
        });
        return;
      }

      const id = crypto.randomUUID();
      const store = new RigChatStore(id, bindingId, root, providerId);
      storesRef.current.set(id, store);
      setSessions((prev) =>
        addSession(prev, { conversationId: id, providerId, createdAt: Date.now(), kind: 'live' })
      );
      setActiveId(id);
      void store.bootstrap().then(() => {
        if (!store.loadError) store.submitPrompt(initialText);
      });
    },
    [providerId, bindingId, root, eagerStore]
  );

  /**
   * Opens a stored session read-only — the History list's one action.
   * Reuses the existing tab if this session is already open (live or
   * replayed) rather than creating a second store for the same id.
   */
  const openReplay = useCallback((stored: RigStoredSession) => {
    if (!storesRef.current.has(stored.id)) {
      const store = new ReplayStore(stored.id);
      storesRef.current.set(stored.id, store);
      setSessions((prev) =>
        addSession(prev, {
          conversationId: stored.id,
          providerId: stored.providerId,
          createdAt: stored.createdAt,
          kind: 'replay',
        })
      );
      void store.load();
    }
    setActiveId(stored.id);
  }, []);

  /**
   * Converts a replay tab into a live session via `loadSession`, in place
   * (same conversationId, same slot in the tab strip) — the resume
   * machinery itself (`RigChatStore`/`AcpLiveSession.resume`'s 120s
   * timeout, "resume must never blank the room," held prompts) is entirely
   * unchanged; this is only what CREATES the live store from a replay's
   * stored row. `initialText` is optional — round: eager session
   * activation added a SECOND trigger that reaches this with none at all
   * (the explicit Resume button, `Composer`'s `onResume`), alongside the
   * original one (typing + sending, `submitInReplay` below): same flow
   * either way, the only difference is whether `submitPrompt` fires once
   * the store's ready. Callers must already know `canResumeSession` is
   * true — this doesn't re-check it.
   */
  const resumeReplay = useCallback(
    (replay: ReplayStore, initialText?: string) => {
      const stored = replay.session;
      if (!stored) return;
      replay.dispose();

      const live = new RigChatStore(stored.id, bindingId, root, stored.providerId, {
        acpSessionId: stored.acpSessionId!,
        title: stored.title,
        titleSource: stored.titleSource,
      });
      storesRef.current.set(stored.id, live);
      setSessions((prev) =>
        addSession(removeSession(prev, stored.id), {
          conversationId: stored.id,
          providerId: stored.providerId,
          createdAt: stored.createdAt,
          kind: 'live',
        })
      );
      void live.bootstrap().then(() => {
        if (!live.loadError && initialText) live.submitPrompt(initialText);
      });
    },
    [bindingId, root]
  );

  /**
   * Typing + sending in a replay tab — one of TWO triggers into
   * `resumeReplay` now (see its own doc comment for the other, the
   * explicit Resume button). Where `canResumeSession` isn't genuinely
   * real, this starts an honest new session instead — a real new row,
   * never a disguised continuation — but keeps it "in that same tab" (the
   * same slot in the strip): the old entry is replaced by the new one
   * rather than opening a second tab.
   */
  const submitInReplay = useCallback(
    (replay: ReplayStore, text: string) => {
      const stored = replay.session;
      if (!stored) return;

      if (canResumeSession(stored.providerId, stored.acpSessionId)) {
        resumeReplay(replay, text);
        return;
      }
      replay.dispose();

      const id = crypto.randomUUID();
      const followUp = new RigChatStore(id, bindingId, root, stored.providerId);
      storesRef.current.delete(stored.id);
      storesRef.current.set(id, followUp);
      setFollowUpIds((prev) => new Set(prev).add(id));
      setSessions((prev) =>
        addSession(removeSession(prev, stored.id), {
          conversationId: id,
          providerId: stored.providerId,
          createdAt: Date.now(),
          kind: 'live',
        })
      );
      setActiveId(id);
      void followUp.bootstrap().then(() => {
        if (!followUp.loadError) followUp.submitPrompt(text);
      });
    },
    [bindingId, root, resumeReplay]
  );

  const closeSession = useCallback(
    (id: string) => {
      storesRef.current.get(id)?.dispose();
      storesRef.current.delete(id);
      setSessions((prev) => {
        const result = closeTab(prev, activeId, id);
        setActiveId(result.activeId);
        return result.sessions;
      });
    },
    [activeId]
  );

  const ordered = byRecency(sessions);
  const activeStore = activeId ? (storesRef.current.get(activeId) ?? null) : null;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <TabStrip
        sessions={ordered}
        activeId={activeId}
        storesRef={storesRef}
        identities={identities}
        onSelect={setActiveId}
        onClose={closeSession}
        onNewTab={() => setActiveId(null)}
        onToggleCollapse={onToggleCollapse}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          {activeStore ? (
            <Transcript
              key={activeStore.conversationId}
              store={activeStore}
              cwd={root}
              onOpenFile={onOpenFile}
              composerHeight={composerHeight}
              isFollowUp={followUpIds.has(activeStore.conversationId)}
            />
          ) : (
            <ZeroStateTranscript
              bindingId={bindingId}
              rigName={name}
              agents={agents}
              agentsLoading={agentsLoading}
              identities={identities}
              onOpenSession={openReplay}
            />
          )}
        </div>
        <div ref={composerRef} className="p-3">
          <Composer
            key={activeStore?.conversationId ?? 'zero-state'}
            store={activeStore}
            agents={agents}
            identities={identities}
            providerId={providerId}
            onProviderChange={pickProvider}
            onStartSession={startSession}
            onSubmitReplay={submitInReplay}
            onResume={resumeReplay}
            density={deriveComposerDensity(composerWidth)}
            eagerStore={eagerStore}
          />
        </div>
      </div>
    </div>
  );
});

/**
 * One row: the tab strip (scrollable, fade-masked edges, never wraps) and
 * the strip-level controls (`+`, collapse) pinned to its own right side —
 * editor/browser-tab convention. The zero-state (`activeId === null`)
 * renders as its own tab rather than a hidden mode, so the strip is never
 * empty once the panel has been touched at all.
 */
/** The title behind a tab, whichever kind of store backs it. */
function sessionTitle(store: RigSession | undefined): string | null {
  if (!store) return null;
  return store.kind === 'live' ? store.title : (store.session?.title ?? null);
}

const TabStrip = observer(function TabStrip({
  sessions,
  activeId,
  storesRef,
  identities,
  onSelect,
  onClose,
  onNewTab,
  onToggleCollapse,
}: {
  sessions: RigSessionSummary[];
  activeId: string | null;
  storesRef: React.RefObject<Map<string, RigSession>>;
  identities: Map<string, AgentIdentity>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  onToggleCollapse: () => void;
}) {
  const inZeroState = activeId === null;
  // Round S2+: double-click a tab to rename it, editor convention (select-
  // all on focus, Enter commits, Escape cancels, blur commits) — see
  // `TabRenameInput`. One id at a time; renaming doesn't change selection.
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="border-border-hairline flex h-10 shrink-0 items-center border-b">
      <div
        role="tablist"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1.5 [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]"
      >
        {sessions.map((s) => {
          const store = storesRef.current.get(s.conversationId);
          const label = deriveTabTitle(sessionTitle(store));
          const active = !inZeroState && s.conversationId === activeId;
          const icon = identities.get(s.providerId)?.icon;

          if (editingId === s.conversationId) {
            return (
              <TabRenameInput
                key={s.conversationId}
                initialValue={sessionTitle(store) ?? ''}
                onCommit={(title) => {
                  store?.rename(title);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            );
          }

          return (
            <Tab
              key={s.conversationId}
              active={active}
              onSelect={() => onSelect(s.conversationId)}
              onDoubleClick={() => setEditingId(s.conversationId)}
              onClose={() => onClose(s.conversationId)}
            >
              {/* Replay tabs read as history at a glance — a stored session
                  is a genuinely different thing from a live one, not a
                  visual footnote. */}
              {s.kind === 'replay' && (
                <History className="text-text-muted size-3 shrink-0" strokeWidth={1.5} />
              )}
              {icon && <AgentIcon icon={icon} size={12} className="shrink-0" />}
              <span className="max-w-28 truncate">{label}</span>
            </Tab>
          );
        })}
        {inZeroState && (
          <Tab
            active
            onSelect={() => {}}
            // Only closable back to a real session — with none, the
            // zero-state tab is the panel's one permanent tab.
            onClose={sessions.length > 0 ? () => onSelect(byRecency(sessions)[0].conversationId) : undefined}
          >
            <MessageSquare className="text-text-muted size-3 shrink-0" strokeWidth={1.5} />
            <span>New session</span>
          </Tab>
        )}
      </div>
      <div className="border-border-hairline flex shrink-0 items-center gap-0.5 border-l px-1.5">
        {/* Bare '+' is VS Code/browser-tab convention (design-system.md rule
            7's own carve-out) — kept icon-only, with a real tooltip since
            the brief calls it borderline. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" onClick={onNewTab} aria-label="New session">
                <Plus className="size-3.5" strokeWidth={1.5} />
              </Button>
            }
          />
          <TooltipContent side="bottom">New session</TooltipContent>
        </Tooltip>
        {/* Collapse: universal chrome, stays icon-only per the same rule. */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapse}
          aria-label="Collapse chat panel"
          title="Collapse chat panel"
        >
          <PanelLeftClose className="size-3.5" strokeWidth={1.5} />
        </Button>
      </div>
    </div>
  );
});

function Tab({
  active,
  onSelect,
  onDoubleClick,
  onClose,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  /** Round S2+ — double-click a tab to rename it (`TabStrip`'s `editingId`). */
  onDoubleClick?: () => void;
  /** Omit to render without a close affordance (the unclosable zero-state tab). */
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      className={cn(
        // No colored rail on the active tab, per the design system —
        // bg-2 + text weight/color shift is the whole affordance.
        'group flex shrink-0 items-center gap-1.5 rounded-control px-2 py-1 text-xs transition-colors',
        active
          ? 'bg-bg-2 text-text-primary'
          : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        className="flex min-w-0 items-center gap-1.5"
      >
        {children}
      </button>
      {onClose && (
        // Close (x) is universal compact chrome (design-system.md rule 7's
        // own example) — stays icon-only.
        <button
          type="button"
          onClick={onClose}
          aria-label="Close session"
          title="Close session"
          className="text-text-muted hover:text-text-primary shrink-0 opacity-0 group-hover:opacity-100"
        >
          <X className="size-3" strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

/**
 * Round S2+ — the tab strip's (and History list's) inline rename input.
 * Editor convention: select-all on focus so typing replaces the whole
 * title in one go, Enter commits, Escape cancels, blur commits (matches
 * what closing focus any other way — clicking elsewhere, Tab-ing away —
 * should honestly mean: "done editing, keep it"). `resolvedRef` guards
 * against Escape's cancel being immediately followed by blur's commit —
 * removing a focused element doesn't reliably fire blur *before* React
 * unmounts it, so without this an Escape could still get overwritten by a
 * trailing commit.
 */
function TabRenameInput({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const resolvedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    const trimmed = value.trim();
    if (trimmed) onCommit(trimmed);
    else onCancel();
  };
  const cancel = () => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
      className="border-accent bg-bg-1 text-text-primary rounded-control h-[26px] w-28 shrink-0 border px-2 text-xs outline-none"
    />
  );
}

/**
 * The transcript-area content when there's no active session: a "no
 * runnable agent" notice when that's genuinely why, otherwise a single
 * quiet mono line plus — when this rig has any — the History list
 * (`persistence-design.md` Round B). No picker, no buttons, no
 * starter-prompt chips (round 12 had these; round 13 killed them as
 * generic filler). Starting a *new* session is entirely the composer's
 * job; opening a *past* one is this list's.
 */
function ZeroStateTranscript({
  bindingId,
  rigName,
  agents,
  agentsLoading,
  identities,
  onOpenSession,
}: {
  bindingId: string;
  rigName: string | null;
  agents: RunnableAgent[];
  agentsLoading: boolean;
  identities: Map<string, AgentIdentity>;
  onOpenSession: (session: RigStoredSession) => void;
}) {
  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <MessageSquare className="text-text-muted size-6" strokeWidth={1.5} />
        <p className="text-text-muted text-sm">
          {agentsLoading
            ? 'Checking for installed agents…'
            : 'No runnable agent found. Install one to start chatting.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center">
        <p className="text-text-muted font-mono text-xs">
          New session{rigName ? ` in ${rigName}` : ''}
        </p>
      </div>
      <SessionHistoryList bindingId={bindingId} identities={identities} onOpenSession={onOpenSession} />
    </div>
  );
}

/**
 * This rig's stored sessions (`rig.sessions.listSessions`), newest-touched
 * first — the one place a past session can be reopened from. Absent
 * entirely when there are none yet, rather than an empty-state placeholder:
 * a rig nobody has chatted in before has nothing honest to show here.
 */
function SessionHistoryList({
  bindingId,
  identities,
  onOpenSession,
}: {
  bindingId: string;
  identities: Map<string, AgentIdentity>;
  onOpenSession: (session: RigStoredSession) => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['rig', 'sessions', 'history', bindingId];
  const { data: sessions } = useQuery<RigStoredSession[]>({
    queryKey,
    queryFn: () => rpc.rig.sessions.listSessions({ bindingId }),
    staleTime: 5_000,
  });
  // Round S2+: no live store backs each row here (this is a plain read of
  // `rig_sessions`, not an open tab) — rename writes straight through the
  // RPC and refetches, rather than going through `RigChatStore`/`ReplayStore`
  // the way the tab strip's rename does. If the same session also happens to
  // be open as a tab right now, that tab's own title won't pick this up
  // until it's reopened — a known, minor gap, not a hidden one.
  const [editingId, setEditingId] = useState<string | null>(null);

  if (!sessions || sessions.length === 0) return null;

  const rename = (sessionId: string, title: string) => {
    void rpc.rig.sessions.rename({ sessionId, title }).then(() => {
      void queryClient.invalidateQueries({ queryKey });
    });
  };

  return (
    <div className="border-border-hairline shrink-0 border-t px-3 py-2">
      <p className="text-text-muted px-1 pb-1 font-mono text-xs tracking-wide uppercase">
        Recent sessions
      </p>
      <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {sessions.map((session) => {
          if (editingId === session.id) {
            return (
              <div key={session.id} className="px-1.5 py-1">
                <TabRenameInput
                  initialValue={session.title ?? ''}
                  onCommit={(title) => {
                    rename(session.id, title);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            );
          }
          const icon = identities.get(session.providerId)?.icon;
          return (
            <div
              key={session.id}
              className="hover:bg-bg-2 group flex items-center gap-1.5 rounded-control px-1.5 py-1"
            >
              <button
                type="button"
                onClick={() => onOpenSession(session)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                {icon && <AgentIcon icon={icon} size={12} className="shrink-0" />}
                <span className="text-text-secondary min-w-0 flex-1 truncate text-xs">
                  {deriveTabTitle(session.title)}
                </span>
              </button>
              <span className="text-text-muted shrink-0 font-mono text-xs">
                {relativeTime(session.updatedAt, Date.now())}
              </span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditingId(session.id);
                }}
                aria-label="Rename session"
                title="Rename session"
                className="text-text-muted hover:text-text-primary shrink-0 opacity-0 group-hover:opacity-100"
              >
                <Pencil className="size-3" strokeWidth={1.5} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Renders either kind of session — a live `RigChatStore` or a read-only
 * `ReplayStore` (`persistence-design.md` Round B). Both feed the same
 * `chatContext`/`chatState` pair into `<ChatTranscript>`; only the
 * load/error plumbing differs (`bootstrap`+`historyLoading`+`loadError` vs
 * `load`+`loading`+`error`), and only a live store binds a view/gets a
 * Retry button — a stored session that fails to load has nothing to retry
 * against, it's just gone.
 */
const Transcript = observer(function Transcript({
  store,
  cwd,
  onOpenFile,
  composerHeight,
  isFollowUp,
}: {
  store: RigSession;
  cwd: string;
  onOpenFile?: (absPath: string) => void;
  composerHeight: number;
  /** One-time muted notice above an empty transcript — a lazy-resume follow-up, not a continuation. */
  isFollowUp: boolean;
}) {
  const viewRef = useRef<ChatView | null>(null);

  useEffect(() => {
    if (store.kind === 'live') {
      void store.bootstrap();
      return () => store.bindView(null);
    }
    void store.load();
    return undefined;
  }, [store]);

  useEffect(() => {
    viewRef.current?.setContentPadding({ bottom: composerHeight });
  }, [composerHeight]);

  const queryClient = useQueryClient();

  const commands = useMemo<ChatCommands>(
    () => ({
      onOpenFile: onOpenFile
        ? (arg) => onOpenFile(arg.path.startsWith('/') ? arg.path : `${cwd}/${arg.path}`)
        : undefined,
      // Synchronous per chat-ui's contract (`Prose.tsx` decides whether to
      // `preventDefault()` a click before the browser navigates) — reads
      // `file-tree.tsx`'s own react-query cache (same key, `['rig', 'files',
      // 'list', root]`) rather than fetching, so it's always answerable
      // in-click. A miss (tree not loaded yet, or the path genuinely isn't
      // in the rig) falls back to `'external'`, which the hardened
      // `setWindowOpenHandler` (main/utils/externalLinks.ts) then quietly
      // denies rather than popping a blank window.
      classifyLink: (href) =>
        classifyProseLink(href, queryClient.getQueryData<RigFileNode[]>(['rig', 'files', 'list', cwd])),
    }),
    [onOpenFile, cwd, queryClient]
  );

  const errorMessage = store.kind === 'live' ? store.loadError?.message : store.error;
  const loading = store.kind === 'live' ? store.historyLoading : store.loading;
  // Round F ("resume must never blank the room"): a replay tab has no local-
  // history-first paint of its own (it only ever shows once fully loaded,
  // unchanged from before), so it's never eligible for the "already have
  // something to protect" treatment below — only a live store's resume path
  // seeds ahead of time (`RigChatStore.hasSeededHistory`).
  const hasSeededHistory = store.kind === 'live' ? store.hasSeededHistory : false;
  const panelMode = deriveTranscriptPanelMode({
    loading,
    hasError: Boolean(errorMessage),
    hasSeededHistory,
  });

  if (panelMode.kind === 'fullPanelError') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-text-primary text-sm">Failed to load chat.</p>
        <p className="text-text-muted text-xs">{errorMessage}</p>
        {store.kind === 'live' && (
          <Button variant="outline" size="sm" onClick={() => store.retry()} className="mt-1">
            Retry
          </Button>
        )}
      </div>
    );
  }

  if (panelMode.kind === 'fullPanelLoading') {
    return (
      <div className="text-text-muted flex h-full items-center justify-center text-sm">
        Loading chat…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isFollowUp && (
        <p className="text-text-muted shrink-0 pt-2 text-center font-mono text-xs">
          Follow-up session
        </p>
      )}
      {store.kind === 'live' && store.resuming && (
        // Quiet inline status, per Rule 9 — the transcript we already have
        // stays fully visible underneath; the wire's `resumeSession` call
        // is one atomic round trip with no incremental progress to show
        // (see `AcpLiveSession.resume`'s doc comment), so this states the
        // mode, not a percentage.
        <p className="text-text-muted shrink-0 pt-2 text-center font-mono text-xs">
          resuming session…
        </p>
      )}
      {panelMode.inlineError && (
        <div className="flex shrink-0 items-center justify-center gap-2 px-3 py-1.5 text-center">
          <span className="text-text-muted text-xs">{errorMessage}</span>
          {store.kind === 'live' && (
            <Button variant="outline" size="xs" onClick={() => store.retry()}>
              Retry
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ChatTranscript
          context={store.chatContext}
          state={store.chatState}
          stickToBottom
          pinUserMessages={store.kind === 'live'}
          commands={commands}
          onReady={(view) => {
            viewRef.current = view;
            if (store.kind === 'live') store.bindView(view);
            view.setContentPadding({ bottom: composerHeight });
            // "Opening a session lands at the bottom" (Round E) — explicit,
            // not just relying on ChatState's own tail default: a resume or
            // replay open seeds a large batch of history in one shot (not a
            // token-by-token stream), and this is the one place that's
            // guaranteed to run exactly once, right as the view mounts for
            // THIS store, regardless of whatever scroll state a previous
            // conversation left behind. `tail` mode then self-maintains
            // through any later content growth (turn commits, streaming) —
            // no further intervention needed.
            view.setScrollMode(tailMode());
          }}
        />
      </div>
    </div>
  );
});

/**
 * The cockpit (design-system.md rule 8): one bordered field, the send
 * control living inside it rather than beside it, and a bottom utility row
 * carrying real state — harness identity/picker on the left, Send/Stop as
 * text+icon on the right. Shared across THREE modes — zero-state
 * (`store === null`, harness chip is the picker), a live session (harness
 * chip is read-only identity), and a replay tab (same read-only identity,
 * plus a quiet mono chip naming the session it'll resume, and sending is
 * the ONE lazy-resume trigger — see `onSubmitReplay`) — one composer, not
 * three. Composer declutter round: this row used to also carry a trailing
 * rig-name chip — dropped as redundant with the topbar breadcrumb, which
 * already names the open rig.
 */
const Composer = observer(function Composer({
  store,
  agents,
  identities,
  providerId,
  onProviderChange,
  onStartSession,
  onSubmitReplay,
  onResume,
  density,
  eagerStore,
}: {
  store: RigSession | null;
  agents: RunnableAgent[];
  identities: Map<string, AgentIdentity>;
  providerId: string | null;
  onProviderChange: (id: string) => void;
  onStartSession: (text: string) => void;
  onSubmitReplay: (store: ReplayStore, text: string) => void;
  /** Round: eager session activation — the explicit Resume affordance, no text required. */
  onResume: (store: ReplayStore) => void;
  /** Composer overlap round — the bottom row's degradation tier, measured off the composer's own rendered width (`composer-density.ts`). */
  density: ComposerDensity;
  /**
   * Round: eager session activation — a zero-state tab's already-connecting
   * store for the currently-selected harness, if any (`chat-panel.tsx`'s
   * own effect owns creating/tearing it down). Read here ONLY for the
   * model/effort/mode pickers, so they populate before any message is
   * sent — the harness picker itself stays `HarnessPicker` (still freely
   * changeable) the whole time this is zero-state; nothing about the
   * `store`-driven identity chip/submit branching below changes.
   */
  eagerStore: RigChatStore | null;
}) {
  const live = store?.kind === 'live' ? store : null;
  const replay = store?.kind === 'replay' ? store : null;
  // Model/effort/mode pickers alone read from the eager store when there's
  // no real live session yet — everything else in this component (identity
  // chip, submit routing, disabled state) is unaffected: it stays keyed on
  // `store`/`live` exactly as before eager start existed. A replay tab
  // never reaches this (session-scoped only, per the mode-control brief).
  const sessionConfigSource = live ?? (!store ? eagerStore : null);

  const [text, setText] = useState(live?.draftText ?? '');
  const affordances = live?.affordances ?? { isWorking: false, canSubmit: true, canCancel: false };
  const permission = live?.permissionQueue[0] ?? null;
  const resolvingPermissionOptionId = live?.resolvingPermissionOptionId ?? null;
  const effectiveProviderId = live?.providerId ?? replay?.session?.providerId ?? providerId;
  // Read-only identity display (an already-decided provider, live or
  // replayed) — static metadata, not the probed list, so a resumed
  // session's chip never flashes blank while agents are still probing.
  const selectedAgent = effectiveProviderId ? (identities.get(effectiveProviderId) ?? null) : null;
  const noAgents = !store && agents.length === 0;
  // A replay tab whose session record hasn't loaded yet has nothing to
  // lazy-resume against — the composer stays disabled until it has.
  const replayNotReady = replay ? replay.loading || !replay.session : false;
  const [resuming, setResuming] = useState(false);
  const showResumeButton =
    !replayNotReady &&
    shouldShowResumeButton({
      hasReplaySession: replay !== null,
      canResume: replay?.session ? canResumeSession(replay.session.providerId, replay.session.acpSessionId) : false,
      hasTypedText: text.trim().length > 0,
    });

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    if (live) {
      live.submitPrompt(trimmed);
    } else if (replay) {
      onSubmitReplay(replay, trimmed);
    } else {
      onStartSession(trimmed);
    }
  }, [live, replay, text, onStartSession, onSubmitReplay]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit]
  );

  const placeholder = noAgents
    ? 'No runnable agent installed'
    : replay
      ? 'Message to continue this session…'
      : 'Message the agent…';
  const disabled = noAgents || replayNotReady;

  return (
    <div className="flex flex-col gap-2">
      {permission && (
        // Aligned into the composer's own flow — a hairline divider, not a
        // detached gray slab (round E: chat-ui has no inline-transcript
        // permission unit, so this stays here, just restyled per the design
        // system: mono command text, `option.kind`-driven button variants,
        // no extra card chrome — Rule 9 reserves card chrome for file-edit
        // summaries).
        <div className="border-border-hairline flex flex-col gap-2 border-b pb-3">
          <span className="flex items-center gap-1.5">
            {/* Round F: the same shield glyph the transcript's own tool line
                uses for its awaiting-permission state (chat-ui's
                `IconShieldAlert`) — so the two surfaces read as the same ask.
                Neutral muted, not chat-ui's one-off amber: this app's tokens
                stay monochrome, teal is reserved for "alive," not alerts. */}
            <ShieldAlert className="text-text-muted size-3.5 shrink-0" strokeWidth={1.5} />
            <span className="text-text-secondary font-mono text-xs break-all">{permission.title}</span>
          </span>
          <div className="flex flex-wrap gap-1.5">
            {permission.options.map((option) => {
              const isReject = option.kind.startsWith('reject');
              const isAlwaysAllow = option.kind === 'allow_always';
              const resolving = resolvingPermissionOptionId === option.optionId;
              return (
                <Button
                  key={option.optionId}
                  size="sm"
                  // Allow = primary (filled); "Always Allow" = outlined
                  // secondary, not filled — filled read as equal weight to
                  // Allow (round F); Reject = ghost, quietest of the three.
                  variant={isReject ? 'ghost' : isAlwaysAllow ? 'outline' : 'default'}
                  // The whole row disables the moment ANY option is picked
                  // (round E 5(b)) — the gap before the runtime actually
                  // starts the tool reads as progress, not a dead click.
                  disabled={resolvingPermissionOptionId !== null}
                  onClick={() => live?.resolvePermission(option.optionId)}
                  // Round: permission option crop — `option.name` is the
                  // ACP adapter's own raw string, sometimes with the whole
                  // shell command restated inline ("Always Allow
                  // Bash(<command>)"), which used to clip at the panel
                  // edge (`Button`'s base class is `whitespace-nowrap
                  // shrink-0` on purpose everywhere else). Not rig-
                  // desktop's text to reformat — the command is already
                  // shown in full on the line above these buttons, so
                  // truncating the label loses nothing; `title` keeps the
                  // untruncated string one hover away.
                  title={option.name}
                >
                  {resolving ? (
                    <>
                      <Check />
                      {isReject ? 'Rejected' : 'Allowed · running…'}
                    </>
                  ) : (
                    <span className="max-w-56 truncate">{option.name}</span>
                  )}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {/* One container, no internal seam — the hairline is the outside
          border only (round 14: the border-t between textarea and utility
          row read as a second attached bar). Both zones share the same
          px-3 inset; vertical rhythm is 4/8/12-scale throughout, tight
          enough that the row sits close under the text rather than
          hanging off it. */}
      <div className="focus-within:border-accent border-border-hairline bg-bg-1 rounded-card border transition-colors">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            live?.setDraftText(e.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="field-sizing-content text-text-primary placeholder:text-text-muted max-h-40 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none disabled:cursor-not-allowed"
        />

        <div className="flex items-center justify-between gap-2 px-3 pb-2">
          {/* Composer overlap round: `min-w-0` lets this cluster shrink as
              a flex item; `flex-wrap` is the last-resort fallback if it's
              STILL too wide even fully degraded (`density`) — wraps to a
              second line instead of spilling under/over Send. Send itself
              gets its own guaranteed `shrink-0` slot below, unconditionally. */}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {store ? (
              selectedAgent && (
                <span className="bg-bg-2 text-text-secondary flex shrink-0 items-center gap-1.5 rounded-control px-2 py-1 text-xs">
                  <AgentIcon icon={selectedAgent.icon} size={12} />
                  <span>{selectedAgent.name}</span>
                </span>
              )
            ) : (
              <HarnessPicker
                agents={agents}
                selectedId={providerId}
                onChange={onProviderChange}
                disabled={noAgents}
                variant="chip"
              />
            )}
            {/* Options-loading round (Dylan's screenshot): a live/eagerly-
                connecting session has nothing in this slot until the
                adapter's own config report lands — model/effort/mode all
                read off the SAME `session.config.current()` (see
                `rig-chat-store.ts`'s getters), so they arrive together;
                "all three still empty" is the one honest signal that
                they're in flight rather than genuinely absent. Quiet mono
                text, no spinner — matches the pickers' own trigger
                typography (`text-xs`) so nothing jumps in size the
                moment the real pickers replace it. */}
            {sessionConfigSource &&
              sessionConfigSource.modelOptions.length === 0 &&
              sessionConfigSource.effortOptions.length === 0 &&
              sessionConfigSource.permissionModeOptions.length === 0 && (
                <span className="text-text-muted px-1.5 py-1 font-mono text-xs">loading options…</span>
              )}
            {/* Model/effort — live (or eagerly-connecting) session state,
                not local state. Honest edges: a replay tab, or a
                zero-state with no eager store connected yet, render
                nothing here — same as `HarnessPicker` being the only
                control before then. Model is the priority element of the
                degradation ladder — it always keeps a (truncated) label,
                never hides outright, even at `density === 'compact'`. */}
            {sessionConfigSource && sessionConfigSource.modelOptions.length > 0 && (
              <MetaOptionPicker
                options={sessionConfigSource.modelOptions}
                selectedId={sessionConfigSource.model}
                onChange={(id) => sessionConfigSource.setModel(id)}
                placeholder="Model"
                compact={density === 'compact'}
              />
            )}
            {/* Effort has no icon to fall back to (`MetaOptionPicker`
                never reserves one — it's text metadata, not an identity),
                so it's the one that disappears at `compact`, not the one
                that shrinks. */}
            {density === 'full' && sessionConfigSource && sessionConfigSource.effortOptions.length > 0 && (
              <MetaOptionPicker
                options={sessionConfigSource.effortOptions}
                selectedId={sessionConfigSource.effort}
                onChange={(id) => sessionConfigSource.setEffort(id)}
                placeholder="Effort"
              />
            )}
            {/* Round: permission mode control — a safety state, not
                metadata (deliberately its own component, not a third
                `MetaOptionPicker`: escalation friction + a persistent
                warning treatment while a dangerous mode is active, see
                `permission-mode-picker.tsx`'s own doc comment). Permission-
                mode persistence round: `lastModeByHarness` DOES now
                remember a picked mode across sessions, same as
                model/effort — but only ever a SAFE one
                (`shouldPersistMode`/`RigChatStore.setMode`); a dangerous
                pick is never written, so "acts without asking" can never
                silently follow the user into a new session.
                Composer overlap round: unlike effort, this keeps its
                shield icon at `compact` — a safety control should never
                vanish silently, only its text label drops. */}
            {sessionConfigSource && sessionConfigSource.permissionModeOptions.length > 0 && (
              <PermissionModePicker
                options={sessionConfigSource.permissionModeOptions}
                selectedId={sessionConfigSource.permissionMode}
                onChange={(id) => sessionConfigSource.setMode(id)}
                iconOnly={density === 'compact'}
              />
            )}
            {/* Replay's own context (which session, from when) — the rig
                itself used to have a matching chip here too, dropped as
                redundant with the topbar breadcrumb's own rig name
                (composer declutter round). Lowest-priority information in
                this row — the first thing to drop at `compact`. */}
            {density === 'full' && replay?.session && (
              <span className="text-text-muted min-w-0 truncate font-mono text-xs">
                {formatSessionFromLabel(replay.session.createdAt)}
              </span>
            )}
          </div>
          {affordances.isWorking ? (
            <Button size="sm" variant="secondary" onClick={() => live?.stop()} aria-label="Stop">
              <Square className="size-3.5" strokeWidth={1.5} />
              Stop
            </Button>
          ) : showResumeButton ? (
            // Round: eager session activation — typing-first still works
            // exactly as before (Send below already resumes-then-sends);
            // this is the SECOND way in, no message required. Same slot
            // Send would occupy once there's text — never both at once.
            <Button
              size="sm"
              disabled={resuming}
              onClick={() => {
                if (!replay) return;
                setResuming(true);
                onResume(replay);
              }}
              aria-label="Resume"
            >
              <Play className="size-3.5" strokeWidth={1.5} />
              {resuming ? 'Resuming…' : 'Resume'}
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={!text.trim() || disabled} aria-label="Send">
              <Send className="size-3.5" strokeWidth={1.5} />
              Send
            </Button>
          )}
        </div>
      </div>

      {live && live.queuedPrompts.length > 0 && (
        <span className="text-text-muted font-mono text-xs">{live.queuedPrompts.length} queued</span>
      )}
      {/* Round F: legible instead of silent — a prompt sent before the
          session exists (still bootstrapping/resuming) used to just vanish;
          now it's held and flushed the moment the session connects (see
          `RigChatStore._heldPrompts`). Mutually exclusive with the "queued"
          line above in practice: this only has anything to show before
          `live.session` exists, that one only once it does. */}
      {live && live.pendingResumeSubmitCount > 0 && (
        <span className="text-text-muted font-mono text-xs">
          {live.pendingResumeSubmitCount} will send when resumed
        </span>
      )}
    </div>
  );
});
