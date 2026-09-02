import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, Home as HomeIcon, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArtefactPane } from '@renderer/features/artifact/artefact-pane';
import {
  closeActiveTab,
  closeTab,
  activateTab,
  moveTab,
  NO_TABS,
  openFileTab,
  openFocusTab,
  type ArtefactTabsState,
} from '@renderer/features/artifact/artefact-tabs';
import { ChatPanel } from '@renderer/features/chat/chat-panel';
import { Home } from '@renderer/features/home/home';
import { Onboarding } from '@renderer/features/onboarding/onboarding';
import { deriveOnboardingSteps } from '@renderer/features/onboarding/onboarding-state';
import {
  deriveRendererBootState,
  type BootDependencyState,
} from '@renderer/features/recovery/boot-state';
import { RecoveryBoundary } from '@renderer/features/recovery/recovery-boundary';
import { RecoverySurface } from '@renderer/features/recovery/recovery-surface';
import { reportRendererFailure } from '@renderer/features/recovery/renderer-error-reporting';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { RigShareButton } from '@renderer/features/rig-share/rig-share-button';
import { InvitesBell } from '@renderer/features/shell/invites-bell';
import { LayoutSwitcher, type RigLayout } from '@renderer/features/shell/layout-switcher';
import {
  deriveNativeCloseTarget,
  type FocusedRigPane,
} from '@renderer/features/shell/native-close-target';
import { RigSwitcher } from '@renderer/features/shell/rig-switcher';
import { SettingsModal } from '@renderer/features/shell/settings-modal';
import { deriveTopbarContext, type TopbarContext } from '@renderer/features/shell/topbar-context';
import { isUpdateReady, shouldAnnounceUpdate } from '@renderer/features/shell/update-status';
import {
  deriveNativeUpdateMenuAction,
  useNativeMenuEvents,
} from '@renderer/features/shell/use-native-menu-events';
import { useUpdateStatus } from '@renderer/features/shell/use-update-status';
import { PinnedCard } from '@renderer/features/workspace/pinned-card';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import { consumeJustAttachedSyncing } from '@renderer/lib/just-attached';
import { LatestRequestGate } from '@renderer/lib/latest-request-gate';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { relPathFromRoot } from '@shared/rig/file-navigator-categories';
import { rigFileChangeChannel } from '@shared/rig/files';
import {
  type RigSettings,
  type RigSettingsLegacyImport,
  rigSettingsChangedChannel,
} from '@shared/rig/settings';
import { rigOpenRecentChannel, type RigWorkspaceDetection } from '@shared/rig/workspace';

type Theme = 'dark' | 'light';
/** What Settings' Appearance section offers: the two explicit themes, or
 * following the OS (`settings.theme: null` on the wire — see `shared/rig/settings.ts`). */
type ThemePreference = Theme | 'system';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readInitialTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return systemTheme();
}

// Fast first paint (see index.html's inline script, which sets `data-theme`
// from this same key before React ever mounts) — main's settings.json is the
// source of truth going forward (persistence-design.md Round A); this stays
// a write-through mirror, never read as authoritative after boot.
function writeThemeMirror(next: Theme): void {
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('rig-theme', next);
  } catch {
    // localStorage unavailable — theme just won't persist across launches.
  }
}

/**
 * Polish round: genuine System support. `shared/rig/settings.ts`'s
 * `theme: 'dark' | 'light' | null` already modeled "no explicit choice yet,
 * follow system" — this hook is what actually makes `null` live, rather
 * than the previous boot-only fallback that never re-checked the OS.
 *
 * `theme` is the applied, paintable value (what `data-theme` is set to);
 * `preference` is what Settings should show selected — `'system'` maps to
 * stored `theme: null`. While `preference === 'system'`, a `matchMedia`
 * listener keeps `theme` following OS changes for as long as the window is
 * open, not just at boot.
 */
function useTheme(): [
  Theme,
  ThemePreference,
  (next: ThemePreference) => void,
  (stored: Theme | null) => void,
] {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  // Optimistic guess: the same explicit value `theme` just booted with, not
  // 'system' — main's reconcile (just below, in App()) corrects this to
  // 'system' shortly after if that's what's actually stored. Guessing
  // 'system' here instead would fire the OS-tracking effect on the very
  // first render and could flash the applied theme away from what
  // `readInitialTheme()` (and index.html's inline script) already painted,
  // right before reconcile flips it back.
  const [preference, setPreference] = useState<ThemePreference>(theme);

  useEffect(() => {
    if (preference !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      const next = systemTheme();
      writeThemeMirror(next);
      setTheme(next);
    };
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [preference]);

  const setThemePreference = useCallback((next: ThemePreference) => {
    setPreference(next);
    const applied = next === 'system' ? systemTheme() : next;
    writeThemeMirror(applied);
    setTheme(applied);
    void rpc.rig.settings.set({ theme: next === 'system' ? null : next });
  }, []);

  // Reconciles local state to what main's settings store says (boot
  // handshake, or a future second window's change event) — never a user
  // action itself, so it never writes back through `rpc.rig.settings.set`.
  const applyFromSettings = useCallback((stored: Theme | null) => {
    setPreference(stored ?? 'system');
    const applied = stored ?? systemTheme();
    writeThemeMirror(applied);
    setTheme(applied);
  }, []);

  return [theme, preference, setThemePreference, applyFromSettings];
}

// ── Chat panel layout: collapse + width, persisted the same way theme is
// (localStorage — "existing settings storage", cheap, no main-process round
// trip needed for a purely cosmetic renderer preference). ──────────────────

const CHAT_WIDTH_MIN = 280;
// Default-split round: raised from 640 — a flat 55-60%-of-window default
// (below) needs real headroom on a typical desktop window (1400px default,
// `main/app/window.ts`) to actually land in that range rather than
// immediately clamping back down. Still a real ceiling on manual resize,
// just a taller one.
const CHAT_WIDTH_MAX = 900;
/**
 * Default-split round: on first open (nothing stored yet), a rig-nearly-
 * empty workspace gave the file/artifact side most of the window — chat
 * panel was a flat 380px regardless of window size (~27% of the 1400px
 * default window). Genuinely proportional now: ~57% of whatever the
 * window's ACTUAL width is at the moment this first renders, clamped to
 * the same min/max as every other width — safe at the 700px minimum
 * window (`minWidth` in `main/app/window.ts`; 57% of 700 ≈ 399px, well
 * inside range) all the way up to an ultra-wide monitor. A flat pixel
 * constant tuned to one window size couldn't do both.
 */
const CHAT_WIDTH_DEFAULT_RATIO = 0.57;
const CHAT_WIDTH_STORAGE_KEY = 'rig-chat-width';
const CHAT_COLLAPSED_STORAGE_KEY = 'rig-chat-collapsed';

/**
 * Swap to `3` to move the chat panel to the right of the artifact panel —
 * the resize handle always sits between them at order `2`. One value drives
 * the whole layout, per the brief. Not a fully symmetric flip: the border
 * side on the chat/handle wrappers below would need swapping too for that;
 * left as a documented gap since this is a knob for future experimentation,
 * not a live user-facing toggle.
 */
const CHAT_PANEL_ORDER = 1;
const ARTIFACT_PANEL_ORDER = CHAT_PANEL_ORDER === 1 ? 3 : 1;
const CHAT_RESIZE_HANDLE_ORDER = 2;
const RENDERER_BOOT_TIMEOUT_MS = 15_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredChatWidth(): number {
  const fallback = clamp(
    window.innerWidth * CHAT_WIDTH_DEFAULT_RATIO,
    CHAT_WIDTH_MIN,
    CHAT_WIDTH_MAX
  );
  try {
    const raw = Number(localStorage.getItem(CHAT_WIDTH_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw, CHAT_WIDTH_MIN, CHAT_WIDTH_MAX) : fallback;
  } catch {
    return fallback;
  }
}

type FolderState =
  | { status: 'empty' }
  | { status: 'detecting'; path: string }
  | { status: 'detected'; path: string; result: RigWorkspaceDetection }
  | { status: 'error'; path: string; message: string };

export function App() {
  const [, themePreference, setThemePreference, applyThemeFromSettings] = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Make-updates-visible round: the gear's dot opens Settings with About
  // already scrolled into view — reset to false on every open so a later
  // plain gear click (once the update's been seen) doesn't keep forcing a
  // scroll nobody asked for this time.
  const [focusAboutOnOpen, setFocusAboutOnOpen] = useState(false);
  const openSettings = useCallback((focusAbout = false) => {
    setFocusAboutOnOpen(focusAbout);
    setSettingsOpen(true);
  }, []);
  const updateStatus = useUpdateStatus();
  const updateSupportedQuery = useQuery({
    queryKey: ['rig', 'updates', 'supported'],
    queryFn: () => rpc.update.isSupported(),
    staleTime: Infinity,
  });
  // The "ready" toast — exactly once per version (`shouldAnnounceUpdate`,
  // pure/tested), regardless of whether Settings is ever opened. Marks the
  // version announced the moment the toast is SHOWN, not on dismiss, which
  // might never fire if the user quits without touching it. `updateStatus`
  // is memoized (`useUpdateStatus`'s own `useMemo`) so this only actually
  // reruns when `state`/`announcedVersion` change, not on every render.
  useEffect(() => {
    if (!shouldAnnounceUpdate(updateStatus.state, updateStatus.announcedVersion)) return;
    const version = updateStatus.state.availableVersion;
    if (!version) return;
    updateStatus.markAnnounced(version);
    toast({
      title: `Rig ${version} is ready`,
      action: { label: 'Restart', onClick: updateStatus.restart },
      closeButton: true,
      duration: Infinity,
    });
  }, [updateStatus]);
  // Polish round: scroll-aware topbar — see `Topbar`'s own comment for why
  // only `<main>` (Home/`FolderResult`) ever sets this away from false.
  const [mainScrolled, setMainScrolled] = useState(false);
  const [folder, setFolder] = useState<FolderState>({ status: 'empty' });
  const openPathRequests = useRef(new LatestRequestGate());
  // First-sync round: the one root, if any, `openPath` just marked as
  // "attached with syncing on" (see `lib/just-attached.ts`) — read by
  // `FileBrowser`/`FileTree` to show a real syncing indicator instead of a
  // bare "Empty folder." the moment a freshly-downloaded rig's tree mounts,
  // before tapd has pulled anything down yet.
  const [syncingRoot, setSyncingRoot] = useState<string | null>(null);
  // The home screen's CONTINUE row wants to open a rig AND land on one
  // specific session (round H1) — `openPath` only knows a path, so this
  // carries the extra target across the async `detect()` round trip to
  // wherever `ChatPanel` ends up mounting. Reset at the top of every
  // `openPath` call (see below), never just after being consumed — so a
  // later plain "Open Folder…" on the SAME rig can't inherit a stale target
  // from an earlier Continue click.
  const [pendingActiveSessionId, setPendingActiveSessionId] = useState<string | null>(null);
  // Onboarding flow round (docs/onboarding-flow-spec.md §2/3/5): the
  // just-created rig's landing doc, opened once `openPath`'s `detect()`
  // resolves bound (see the effect below) — same "carry the extra target
  // across the async round trip" pattern `pendingActiveSessionId` already
  // uses. `justCreatedRig` additionally arms the topbar's inline
  // auto-rename and the artefact pane's one-time landing fade; both are
  // consumed (and cleared) by what they drive, never by a timeout.
  const [pendingOpenAbsPath, setPendingOpenAbsPath] = useState<string | null>(null);
  const [justCreatedRig, setJustCreatedRig] = useState(false);
  // Motion round (docs/onboarding-flow-spec.md §5): one reveal, the FIRST
  // time the landing doc's pane mounts — set alongside opening it (below),
  // cleared once the fade has actually played so a later file/tab switch
  // never replays it. `prefersReducedMotion` (framer-motion's own
  // `matchMedia` hook) skips the transform/fade entirely, per the spec.
  const [showLandingFade, setShowLandingFade] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  // Session-first viewer: the artefact pane's tabs. Empty means the pane
  // doesn't exist — the session owns the window and the pinned card floats
  // over it (state A). See `features/artifact/artefact-tabs.ts`.
  const [artefact, setArtefact] = useState<ArtefactTabsState>(NO_TABS);
  // Layout-switcher round: replaces the old `artefactCollapsed`/
  // `chatCollapsed` booleans (which could disagree) with one enum, driven
  // by the topbar's `LayoutSwitcher`. Per-session, deliberately not
  // persisted — same as the fold states it replaces.
  const [rigLayout, setRigLayout] = useState<RigLayout>('chat');
  const [focusedRigPane, setFocusedRigPane] = useState<FocusedRigPane>('chat');
  const chatNativeCloseRef = useRef<(() => void) | null>(null);
  const [canCloseChatTab, setCanCloseChatTab] = useState(false);
  const registerChatNativeClose = useCallback((action: (() => void) | null) => {
    chatNativeCloseRef.current = action;
    setCanCloseChatTab(Boolean(action));
  }, []);
  const [chatWidth, setChatWidth] = useState<number>(readStoredChatWidth);
  const chatWidthRef = useRef(chatWidth);
  chatWidthRef.current = chatWidth;
  // Round H2's onboarding gate — null until the settings handshake below
  // resolves at least once; App renders NOTHING (not the wizard, not the
  // normal shell) while this is null, so a fresh boot never flashes the
  // wrong one before the real value is known.
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState<boolean | null>(null);
  const [settingsBootState, setSettingsBootState] = useState<BootDependencyState>('pending');
  const [bootAttempt, setBootAttempt] = useState(0);
  const [bootOverride, setBootOverride] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const authStatusQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });

  // One-time localStorage → main handshake (persistence-design.md Round A).
  // `importLegacy` is a no-op after its first successful call — main keys
  // "already migrated" on whether settings.json exists yet, not on a flag
  // this renderer tracks — so it's safe to call unconditionally on every
  // boot. Its result (and every later change event) is also the reconcile
  // source: local state and the localStorage mirror both snap to match
  // whatever main says, never the reverse, since main owns the value once
  // this handshake has run.
  useEffect(() => {
    let active = true;
    setBootTimedOut(false);
    const timeout = window.setTimeout(() => setBootTimedOut(true), RENDERER_BOOT_TIMEOUT_MS);
    const legacy: RigSettingsLegacyImport = {};
    try {
      const storedTheme = localStorage.getItem('rig-theme');
      if (storedTheme === 'light' || storedTheme === 'dark') legacy.theme = storedTheme;
      const storedWidth = Number(localStorage.getItem(CHAT_WIDTH_STORAGE_KEY));
      if (Number.isFinite(storedWidth) && storedWidth > 0) legacy.chatPanelWidth = storedWidth;
      const storedCollapsed = localStorage.getItem(CHAT_COLLAPSED_STORAGE_KEY);
      if (storedCollapsed !== null) legacy.chatPanelCollapsed = storedCollapsed === 'true';
    } catch {
      // localStorage unavailable — nothing to import; main's own defaults stand.
    }

    const reconcile = (settings: RigSettings) => {
      if (!active) return;
      applyThemeFromSettings(settings.theme);
      if (settings.chatPanelWidth !== null) {
        setChatWidth(clamp(settings.chatPanelWidth, CHAT_WIDTH_MIN, CHAT_WIDTH_MAX));
      }
      setHasSeenOnboarding(settings.hasSeenOnboarding);
      setSettingsBootState('ready');
    };

    rpc.rig.settings
      .importLegacy(legacy)
      .then(reconcile)
      .catch((error: unknown) => {
        if (!active) return;
        setSettingsBootState('failed');
        reportRendererFailure('unhandled-error', error);
      });
    const off = events.on(rigSettingsChangedChannel, reconcile);
    return () => {
      active = false;
      window.clearTimeout(timeout);
      off();
    };
    // `applyThemeFromSettings` is stable (useTheme's own useCallback has
    // empty deps) — listed for exhaustive-deps honesty, not because it
    // ever changes.
  }, [applyThemeFromSettings, bootAttempt]);

  const authBootState: BootDependencyState = authStatusQuery.isPending
    ? 'pending'
    : authStatusQuery.isError
      ? 'failed'
      : 'ready';
  const rendererBootState = deriveRendererBootState({
    settings: settingsBootState,
    auth: authBootState,
    override: bootOverride,
    timedOut: bootTimedOut,
  });
  const retryBoot = useCallback(() => {
    setBootOverride(false);
    setSettingsBootState('pending');
    setBootAttempt((attempt) => attempt + 1);
    void authStatusQuery.refetch();
  }, [authStatusQuery]);

  // Shared by the Open Folder… dialog and the native Open Recent flow below
  // — same detect-and-bind path either way, so a recent rig opens exactly
  // like one picked by hand. Single window, v1: this always replaces
  // whatever rig is currently open rather than spawning a second window.
  const openPath = useCallback(async (picked: string, opts?: { activeSessionId?: string }) => {
    const requestToken = openPathRequests.current.begin();
    setArtefact(NO_TABS);
    setFolder({ status: 'detecting', path: picked });
    setPendingActiveSessionId(opts?.activeSessionId ?? null);
    try {
      const result = await rpc.rig.workspace.detect(picked);
      if (!openPathRequests.current.isCurrent(requestToken)) {
        if (result.bound) void rpc.rig.files.releaseRoot({ rootId: result.rootId });
        return;
      }
      setFolder({ status: 'detected', path: picked, result });
      // First-sync round: a plain open never marks this (`consumeJustAttachedSyncing`
      // returns false for any path nobody just ran `rig attach` for), so this
      // is a no-op for the overwhelming majority of opens — see
      // `lib/just-attached.ts`'s own header comment for why this is a
      // same-tick handoff rather than a prop threaded through `onOpenPath`.
      setSyncingRoot(
        result.bound && consumeJustAttachedSyncing(result.workspaceRoot)
          ? result.workspaceRoot
          : null
      );
    } catch (error) {
      if (!openPathRequests.current.isCurrent(requestToken)) return;
      setFolder({
        status: 'error',
        path: picked,
        message: error instanceof Error ? error.message : 'Could not check this folder.',
      });
    }
  }, []);

  // Home's rig rail: open a session's rig via the same `openPath` every
  // other entry point uses, with the session id riding along so
  // `ChatPanel` can make it the active tab once it mounts (see
  // `pendingActiveSessionId` above and `ChatPanel`'s `initialActiveSessionId`).
  const continueSession = useCallback(
    (path: string, sessionId: string) => {
      void openPath(path, { activeSessionId: sessionId });
    },
    [openPath]
  );

  // Onboarding flow round: Home's one-click create hands back the new
  // rig's path and its seeded landing doc — opens it the normal way,
  // arming the doc-open (below) and the topbar's inline auto-rename
  // (`RigSwitcher`'s `autoEdit`) for once it actually binds.
  const openCreatedRig = useCallback(
    (path: string, docAbsPath: string | null) => {
      setPendingOpenAbsPath(docAbsPath);
      setJustCreatedRig(true);
      void openPath(path);
    },
    [openPath]
  );

  const openFolder = useCallback(async () => {
    let picked: string | undefined;
    try {
      picked = await rpc.app.openSelectDirectoryDialog({
        title: 'Open a rig',
        message: 'Choose a folder to open',
      });
    } catch (error) {
      // The dialog RPC now rethrows on failure instead of hanging silently
      // (see `main/core/app/service.ts`'s own hardening) — this is the
      // "clearly fail" half of that fix: a real message, not a dead click.
      toast({
        title: "Couldn't open the folder picker",
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
      return;
    }
    if (!picked) return;
    await openPath(picked);
  }, [openPath]);

  // Native "Open Recent" (macOS): a cold-launch pick is buffered in main
  // until the renderer can consume it (`consumePendingOpenFile`); a pick
  // made while already running arrives as a live event instead.
  useEffect(() => {
    rpc.rig.workspace
      .consumePendingOpenFile()
      .then((path) => {
        if (path) void openPath(path);
      })
      .catch(() => {});
    return events.on(rigOpenRecentChannel, (path) => {
      void openPath(path);
    });
    // `openPath` is stable (its own useCallback has empty deps) — listed for
    // exhaustive-deps honesty, not because it ever changes.
  }, [openPath]);

  const bound =
    folder.status === 'detected' && folder.result.bound
      ? {
          root: folder.result.workspaceRoot,
          rootId: folder.result.rootId,
          name: folder.result.name,
          bindingId: folder.result.bindingId,
        }
      : null;

  // A different rig opened (or the folder closed): the open tabs belong to
  // the previous root.
  useEffect(() => {
    setArtefact(NO_TABS);
    setRigLayout('chat');
    setFocusedRigPane('chat');
  }, [bound?.root]);

  // Title-reactivity round: `bound.name` (the topbar/`RigSwitcher`'s title,
  // via `deriveTopbarContext`) used to be read exactly once, at `openPath`'s
  // own `rpc.rig.workspace.detect` call — if `rig.toml` hadn't synced down
  // yet (a freshly downloaded shared rig), the title stuck on "Unnamed rig"
  // until the user navigated away and back (a fresh `detect`). Subscribes
  // to the SAME file-watcher signal `file-tree.tsx` already uses for this
  // root (refcounted — an independent watch registration, not a race with
  // that one) and re-reads just the name (`rpc.rig.workspace.readName`, no
  // side effects, unlike `detect`) whenever anything under the root
  // changes, including `rig.toml` first appearing — or a rename elsewhere
  // syncing back down.
  useEffect(() => {
    const root = bound?.root;
    const rootId = bound?.rootId;
    if (!root || !rootId) return;
    void rpc.rig.files.watch({ rootId });
    const off = events.on(rigFileChangeChannel, ({ rootId: changedRootId }) => {
      if (changedRootId !== rootId) return;
      void rpc.rig.workspace.readName(rootId).then((name) => {
        setFolder((prev) => {
          if (
            prev.status !== 'detected' ||
            !prev.result.bound ||
            prev.result.workspaceRoot !== root
          ) {
            return prev;
          }
          if (prev.result.name === name) return prev;
          return { ...prev, result: { ...prev.result, name } };
        });
      });
    });
    return () => {
      off();
      void rpc.rig.files.unwatch({ rootId });
    };
  }, [bound?.root, bound?.rootId]);

  // The root handle is a renderer filesystem capability, not a durable rig
  // identifier. Revoke it whenever this workspace is replaced or closed;
  // `releaseRoot` also tears down any late watcher registrations.
  useEffect(() => {
    const rootId = bound?.rootId;
    if (!rootId) return;
    return () => {
      void rpc.rig.files.releaseRoot({ rootId });
    };
  }, [bound?.rootId]);

  // Round F: there was no way back from a workspace to the home screen —
  // just closes the rig view (`folder` back to `'empty'`, which is exactly
  // the state `Home` renders under). Sessions/tabs round-trip for free:
  // `ChatPanel` persists `lastOpenTabsByRig[bindingId]` independently of
  // `folder`, so reopening the SAME rig later (via `openPath`, from `Home`'s
  // RIGS row or a fresh Open Folder…) restores them exactly as left, without
  // this needing to touch that state at all.
  const goHome = useCallback(() => {
    openPathRequests.current.invalidate();
    setFolder({ status: 'empty' });
    setSyncingRoot(null);
    setPendingActiveSessionId(null);
    setPendingOpenAbsPath(null);
    setJustCreatedRig(false);
    setShowLandingFade(false);
  }, []);

  // Round (beyond-markdown): every file opens now — `ArtifactView` itself
  // routes on real type detection (markdown/text/image/unsupported, see
  // `file-type.ts`), down to a designed empty state for anything it
  // genuinely can't preview.
  //
  // Session-first viewer: every open funnels through here (chat file
  // chips, the pinned card, the navigator, the focus view) into a TAB —
  // and marks the file seen, since opening it is exactly what "seen"
  // means. The old open-vs-reveal split is gone with the resident tree.
  const boundBindingId = bound?.bindingId ?? null;
  const boundRoot = bound?.root ?? null;
  const openFile = useCallback(
    (absPath: string) => {
      if (boundRoot && boundBindingId) {
        const relPath = relPathFromRoot(boundRoot, absPath);
        if (relPath) void rpc.rig.seenState.markSeen({ bindingId: boundBindingId, relPath });
      }
      setRigLayout((current) => (current === 'chat' ? 'split' : current));
      setFocusedRigPane('artifact');
      setArtefact((current) => openFileTab(current, absPath));
    },
    [boundRoot, boundBindingId]
  );

  // Onboarding flow round: once the just-created rig actually binds, open
  // its landing doc the same way any other file-open does (Preview is
  // already the default for markdown, `preview-mode-memory.ts`) — this is
  // the async round trip `openCreatedRig` above armed `pendingOpenAbsPath`
  // for.
  useEffect(() => {
    if (!boundRoot || !pendingOpenAbsPath) return;
    openFile(pendingOpenAbsPath);
    setPendingOpenAbsPath(null);
    setShowLandingFade(true);
  }, [boundRoot, pendingOpenAbsPath, openFile]);

  const openFocus = useCallback(() => {
    setRigLayout((current) => (current === 'chat' ? 'split' : current));
    setFocusedRigPane('artifact');
    setArtefact((current) => openFocusTab(current));
  }, []);

  // Layout-switcher round: switching to split/files with no tabs open has
  // nothing to show there yet — the direct door is the focus view, same as
  // the pinned card's own "Focus" action.
  const applyLayout = useCallback((next: RigLayout) => {
    if (next !== 'chat') {
      setArtefact((current) => (current.tabs.length > 0 ? current : openFocusTab(current)));
    }
    if (next === 'chat') setFocusedRigPane('chat');
    if (next === 'files') setFocusedRigPane('artifact');
    setRigLayout(next);
  }, []);

  // Esc closes the active tab (the split collapses back to the full
  // session when the last one goes) — but only when focus isn't inside
  // something that already owns Escape (the CM6 editor, the comment
  // composer's mention dropdown — see comments-margin.tsx). The chat-only
  // layout ignores Esc: closing tabs you can't see is a trap.
  useEffect(() => {
    if (artefact.tabs.length === 0 || rigLayout === 'chat') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('textarea, input, [contenteditable="true"], .cm-editor')
      ) {
        return;
      }
      setArtefact((current) => closeActiveTab(current));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [artefact.tabs.length, rigLayout]);

  // Closing the last tab collapses the split — there's nothing left for
  // split/files to show. Guarded by the `rigLayout !== 'chat'` check itself
  // so this never loops once already 'chat'.
  useEffect(() => {
    if (artefact.tabs.length === 0 && rigLayout !== 'chat') setRigLayout('chat');
  }, [artefact.tabs.length, rigLayout]);

  const onChatResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = chatWidthRef.current;
    const sign = CHAT_PANEL_ORDER === 1 ? 1 : -1;

    const onMove = (moveEvent: PointerEvent) => {
      setChatWidth(
        clamp(startWidth + sign * (moveEvent.clientX - startX), CHAT_WIDTH_MIN, CHAT_WIDTH_MAX)
      );
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(chatWidthRef.current));
      } catch {
        // localStorage unavailable — width just won't persist.
      }
      void rpc.rig.settings.set({ chatPanelWidth: chatWidthRef.current });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const onOnboardingComplete = useCallback(() => {
    setHasSeenOnboarding(true);
    void rpc.rig.settings.set({ hasSeenOnboarding: true });
  }, []);

  const onboardingSteps = deriveOnboardingSteps({
    hasSeenOnboarding: hasSeenOnboarding ?? true,
    signedIn: authStatusQuery.data?.signedIn ?? false,
  });
  const canOpenNativeSettings = rendererBootState === 'ready' && onboardingSteps.length === 0;
  const nativeCloseTarget = deriveNativeCloseTarget({
    settingsOpen,
    hasRig: bound !== null,
    layout: rigLayout,
    focusedPane: focusedRigPane,
    hasArtifactTab: artefact.tabs.length > 0,
    hasChatTab: canCloseChatTab,
  });
  const closeNativeTarget = useCallback(() => {
    switch (nativeCloseTarget) {
      case 'settings':
        setSettingsOpen(false);
        return;
      case 'artifact':
        setArtefact((current) => closeActiveTab(current));
        return;
      case 'chat':
        chatNativeCloseRef.current?.();
        return;
      case null:
        return;
    }
  }, [nativeCloseTarget]);
  const openNativeSettings = useCallback(() => openSettings(false), [openSettings]);
  const nativeUpdateAction = deriveNativeUpdateMenuAction(
    updateSupportedQuery.data,
    updateStatus.state.status
  );
  const runNativeUpdateAction = useCallback(() => {
    if (nativeUpdateAction === 'restart') {
      updateStatus.restart();
      return;
    }
    openSettings(true);
    updateStatus.check();
  }, [nativeUpdateAction, openSettings, updateStatus]);

  useNativeMenuEvents({
    canOpenSettings: canOpenNativeSettings,
    canCloseTab: nativeCloseTarget !== null,
    updateAction: nativeUpdateAction,
    onOpenSettings: openNativeSettings,
    onCloseTab: closeNativeTarget,
    onUpdateAction: runNativeUpdateAction,
  });

  if (rendererBootState !== 'ready') {
    return (
      <RecoverySurface
        state={rendererBootState}
        detail={
          rendererBootState === 'failed'
            ? bootTimedOut
              ? 'Startup did not finish before the deadline. Retry startup or reload the window.'
              : 'Settings could not be loaded. Retry startup or reload the window.'
            : 'Account status is temporarily unavailable. You can retry or continue with defaults.'
        }
        onRetry={retryBoot}
        onContinue={rendererBootState === 'degraded' ? () => setBootOverride(true) : undefined}
      />
    );
  }

  if (onboardingSteps.length > 0) {
    return <Onboarding steps={onboardingSteps} onComplete={onOnboardingComplete} />;
  }

  return (
    <div className="relative flex h-full flex-col">
      <Topbar
        context={deriveTopbarContext(
          bound ? { name: bound.name, bindingId: bound.bindingId, path: bound.root } : null
        )}
        variant={bound ? 'rig' : 'home'}
        scrolled={!bound && mainScrolled}
        onGoHome={goHome}
        onOpenSettings={openSettings}
        onOpenPath={openPath}
        onOpenFolder={openFolder}
        updateReady={isUpdateReady(updateStatus.state)}
        autoEditRigName={justCreatedRig}
        onAutoEditRigNameHandled={() => setJustCreatedRig(false)}
        // Session-first viewer: rig-level Share lives in the topbar now —
        // the panel header that used to carry it went with the resident
        // file browser.
        shareSlot={bound ? <RigShareButton root={bound.root} name={bound.name} /> : undefined}
        layoutSlot={
          bound ? (
            <LayoutSwitcher
              layout={rigLayout}
              hiddenTabCount={rigLayout === 'chat' ? artefact.tabs.length : 0}
              onChange={applyLayout}
            />
          ) : undefined
        }
      />
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        themePreference={themePreference}
        onSetThemePreference={setThemePreference}
        focusAbout={focusAboutOnOpen}
      />
      {bound ? (
        // The bar sits above ChatPanel/FileBrowser/ArtifactView here, but
        // none of them scroll directly beneath it — each owns its own
        // header chrome (FileBrowser/ArtifactView's own breadcrumb bar,
        // ChatPanel's composer) immediately below the topbar's 40px, so
        // there's nothing for the topbar to react to; `pt-10` alone
        // reproduces the old normal-flow clearance now that the bar is an
        // absolute overlay instead of a flow sibling. `scrolled` above is
        // hardcoded false for this branch — its `variant: 'rig'` bar wears
        // a static hairline instead (see `Topbar`'s own comment).
        // Layout-switcher round: `rigLayout` replaces the old
        // `artefactCollapsed`/`chatCollapsed` pair (which could disagree)
        // with one enum, driven by the topbar's `LayoutSwitcher`. 'chat' is
        // the session owning the window with the rig's state floating over
        // it as the pinned card; 'split' narrows chat to its stored width
        // and gives the artefact pane the rest; 'files' folds chat down to
        // `ChatPanel`'s own session rail and gives the artefact pane
        // everything else. The chat wrapper is the same element across all
        // three layouts, so `ChatPanel` never remounts when it changes.
        <div className="flex min-h-0 flex-1 pt-10">
          <div
            style={{
              order: CHAT_PANEL_ORDER,
              width: rigLayout === 'split' ? chatWidth : undefined,
            }}
            onPointerDownCapture={() => setFocusedRigPane('chat')}
            onFocusCapture={() => setFocusedRigPane('chat')}
            className={cn(
              'relative flex shrink-0 flex-col overflow-hidden bg-bg-1',
              rigLayout === 'chat' && 'min-w-0 flex-1',
              rigLayout === 'files' && 'border-border-hairline w-10 border-r'
            )}
          >
            <RecoveryBoundary scope="Chat panel">
              <ChatPanel
                root={bound.root}
                rootId={bound.rootId}
                bindingId={bound.bindingId}
                name={bound.name}
                initialActiveSessionId={pendingActiveSessionId}
                onOpenFile={openFile}
                collapsed={rigLayout === 'files'}
                onExpand={() => {
                  setFocusedRigPane('chat');
                  setRigLayout('split');
                }}
                onNativeCloseActionChange={registerChatNativeClose}
              />
            </RecoveryBoundary>
            {rigLayout === 'chat' && (
              <PinnedCard
                root={bound.root}
                rootId={bound.rootId}
                bindingId={bound.bindingId}
                name={bound.name}
                syncing={bound.root === syncingRoot}
                onOpenFile={(absPath) => openFile(absPath)}
                onOpenFocus={openFocus}
              />
            )}
          </div>

          {rigLayout === 'split' && (
            // The handle IS the panel divider (no separate border-r on the
            // chat wrapper above) — a wide, easy-to-grab hit area with a
            // thin centered line so it reads as a hairline at rest and only
            // widens visually on hover/drag.
            <div
              style={{ order: CHAT_RESIZE_HANDLE_ORDER }}
              onPointerDown={onChatResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat panel"
              className="group relative w-2.5 shrink-0 cursor-col-resize"
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-hairline transition-colors group-hover:bg-accent/50 group-active:bg-accent/70" />
            </div>
          )}

          {rigLayout !== 'chat' &&
            (() => {
              const pane = (
                <ArtefactPane
                  root={bound.root}
                  rootId={bound.rootId}
                  bindingId={bound.bindingId}
                  state={artefact}
                  onActivateTab={(index) => setArtefact((current) => activateTab(current, index))}
                  onCloseTab={(index) => setArtefact((current) => closeTab(current, index))}
                  onMoveTab={(from, to) => setArtefact((current) => moveTab(current, from, to))}
                  onOpenFile={(absPath) => openFile(absPath)}
                  onOpenFocus={openFocus}
                />
              );
              // Motion round: the landing doc's pane fades up on its first
              // mount after creation (docs/onboarding-flow-spec.md §5) — a
              // plain opacity reveal, no transform, skipped entirely under
              // reduced motion. `showLandingFade` is one-shot: cleared the
              // moment the fade finishes, so switching tabs later never
              // replays it.
              if (showLandingFade && !prefersReducedMotion) {
                return (
                  <motion.div
                    style={{ order: ARTIFACT_PANEL_ORDER }}
                    onPointerDownCapture={() => setFocusedRigPane('artifact')}
                    onFocusCapture={() => setFocusedRigPane('artifact')}
                    className="flex min-h-0 min-w-0 flex-1 flex-col"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                    onAnimationComplete={() => setShowLandingFade(false)}
                  >
                    {pane}
                  </motion.div>
                );
              }
              return (
                <div
                  style={{ order: ARTIFACT_PANEL_ORDER }}
                  onPointerDownCapture={() => setFocusedRigPane('artifact')}
                  onFocusCapture={() => setFocusedRigPane('artifact')}
                  className="flex min-h-0 min-w-0 flex-1 flex-col"
                >
                  {pane}
                </div>
              );
            })()}
        </div>
      ) : (
        // Round H2 feedback: `items-center justify-center` directly on the
        // SCROLLING element clips content taller than the viewport at the
        // TOP with no way to scroll to it — flexbox centers by giving the
        // overflowing child a negative start offset, which a plain
        // `overflow-auto` container can't scroll past (classic flexbox-
        // centering-clips-the-start bug). Fix: `main` only scrolls (no
        // alignment of its own); each branch's own min-h-full wrapper does
        // the centering — when content fits, it centers exactly as before;
        // when it's taller, the wrapper just grows and `main` scrolls it as
        // ordinary block content, top included.
        //
        // Round: HOME RESTRUCTURE — `Home` itself owns its own full-width
        // three-region layout now (the horizontal spread the new IA calls
        // for), so it renders directly in `main`, not inside the centered
        // narrow-card wrapper `FolderResult` still needs.
        //
        // Polish round: this is the one surface the topbar genuinely
        // overlays (see `Topbar`'s own comment) — `ref`/`onScroll` feed
        // `mainScrolled` above, and `pt-10` replaces the clearance the old
        // normal-flow topbar used to give it for free.
        <main
          onScroll={(event) => setMainScrolled(event.currentTarget.scrollTop > 4)}
          className="min-h-0 flex-1 overflow-y-auto pt-10"
        >
          {folder.status === 'empty' ? (
            <Home
              onOpenFolder={openFolder}
              onOpenPath={openPath}
              onContinueSession={continueSession}
              onRigCreated={openCreatedRig}
            />
          ) : (
            <div className="flex min-h-full items-center justify-center p-8">
              <FolderResult
                folder={folder}
                onOpenFolder={openFolder}
                onRetryOpen={(path) => void openPath(path)}
                onCancel={goHome}
              />
            </div>
          )}
        </main>
      )}
    </div>
  );
}

function Topbar({
  context,
  variant,
  scrolled,
  onGoHome,
  onOpenSettings,
  onOpenPath,
  onOpenFolder,
  updateReady,
  shareSlot,
  layoutSlot,
  autoEditRigName,
  onAutoEditRigNameHandled,
}: {
  context: TopbarContext;
  /** Which bottom-edge treatment the bar wears (Dylan's seam call, this
   * round): `'home'` keeps the scroll-aware one (no line at rest, hairline +
   * blur only once content beneath has scrolled — the bar genuinely
   * overlays Home); `'rig'` wears a STATIC hairline — the bound-rig view's
   * panels never flow beneath the bar, so a permanent quiet delineation is
   * honest, and without it the panel divider hitting the bar read
   * ambiguous. One bar, two edge treatments — not a fork. */
  variant: 'home' | 'rig';
  /** Whether the content directly beneath the bar has scrolled away from
   * its top — only meaningful for `variant: 'home'` (the one surface the
   * bar overlays; the bound-rig branch hardcodes it false). */
  scrolled: boolean;
  /** The mini-breadcrumb's house button (rig view only) — up-navigation
   * lives HERE now, not in the panel headers below the bar. */
  onGoHome: () => void;
  /** `true` scrolls Settings straight to About — the gear's own click passes this along as `updateReady` (see below), never called with `true` from anywhere else. */
  onOpenSettings: (focusAbout?: boolean) => void;
  /** Threaded down to `InvitesBell` — its post-accept "Set up locally" opens the result the same way every other "open a rig" entry point does. Also `RigSwitcher`'s own row clicks. */
  onOpenPath: (path: string) => void;
  /** `RigSwitcher`'s "Open folder…" escape hatch — the native picker, same `openFolder` flow every other entry point uses. */
  onOpenFolder: () => void;
  /**
   * Make-updates-visible round: a small accent dot on the gear, ONLY once
   * a download has genuinely finished and is installable — never during
   * checking/downloading (noise about work nobody asked to watch). Clears
   * itself the moment `isUpdateReady` goes false again (after install).
   */
  updateReady: boolean;
  /** Session-first viewer: the rig-level Share button (rig view only) — rendered in the right cluster, leading the account/gear icons. */
  shareSlot?: React.ReactNode;
  /** Layout-switcher round: the chat/split/files segmented control (rig view only) — rendered in the right cluster, ahead of the account/gear icons. */
  layoutSlot?: React.ReactNode;
  /** Onboarding flow round: true immediately after this rig was just created — passed through to `RigSwitcher`'s `autoEdit`. */
  autoEditRigName?: boolean;
  /** Called once `autoEditRigName`'s inline rename has been entered, so `App` can drop the flag. */
  onAutoEditRigNameHandled?: () => void;
}) {
  return (
    // The window is `titleBarStyle: 'hiddenInset'` (main/app/window.ts) — no
    // native title bar, just the traffic lights at (10, 10). This header is
    // the drag region standing in for it: `drag` on the strip so the window
    // moves by its empty space, `no-drag` on every interactive child so
    // clicks still land, and enough left padding to clear the traffic-light
    // cluster (mirrors emdash's `Titlebar.tsx`, `pl-18` for the same reason).
    //
    // Header-dedup round, take 3 (Dylan's inspection): aligned BY
    // CONSTRUCTION, comfortable height. `trafficLightPosition` is OURS to
    // set — instead of contorting the bar around the lights' default spot,
    // `main/app/window.ts` places the 12px circles at y = 14 so they center
    // on this 40px (`h-10`) bar's own axis, y = 20. One flex row, plain
    // `items-center`, no per-child heights or pixel offsets: title, house
    // button (24px), avatar trigger (28px) and gear (28px) all center at 20
    // because the row is 40 and the lights were MOVED to 20. Both content
    // branches below clear the bar with `pt-10`. Lights sit at x 14–66
    // (3 × 12px + 2 × 8px gaps from x = 14), so `pl-[78px]` still clears
    // them with a 12px gap.
    //
    // The far-left slot (Codex-style, hard left after the lights) is a
    // mini-breadcrumb in the rig view: [⌂] › (folder) rig-name — the house
    // is the ONE up-navigation affordance now (icon-only is fine in
    // title-bar chrome, Rule 7's carve-out; the panel headers below carry
    // none). Home keeps the slot empty — no crumb, no title. No
    // logo/wordmark (Dylan's earlier call still stands). The right cluster
    // is icon-only by design: the account avatar and the Settings gear.
    //
    // Bottom edge, per `variant` (see the prop's own doc comment): `'rig'`
    // wears a static hairline; `'home'` keeps the scroll-aware treatment —
    // continuous at rest, translucent blur + hairline together over a quiet
    // 150ms once the content beneath has actually scrolled, never as bar
    // decoration. Absolutely positioned either way, so Home's content flows
    // underneath it.
    <header
      className={cn(
        'absolute inset-x-0 top-0 z-30 flex h-10 shrink-0 items-center justify-between gap-2 pr-4 pl-[78px] transition-[background-color,border-color,backdrop-filter] duration-150 [-webkit-app-region:drag]',
        variant === 'rig'
          ? 'bg-bg-1 border-border-hairline border-b'
          : scrolled
            ? 'bg-bg-1/75 border-border-hairline border-b backdrop-blur-sm'
            : 'bg-bg-1 border-b border-transparent'
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
        {context.kind === 'rig' && (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onGoHome}
                    aria-label="Home"
                    className="flex size-6 shrink-0 items-center justify-center rounded-control text-text-secondary transition-colors [-webkit-app-region:no-drag] hover:bg-bg-2 hover:text-text-primary"
                  >
                    <HomeIcon className="size-3.5" strokeWidth={1.5} />
                  </button>
                }
              />
              <TooltipContent side="bottom">Home</TooltipContent>
            </Tooltip>
            <ChevronRight className="size-3 shrink-0" strokeWidth={1.5} />
            <RigSwitcher
              // Keyed so switching to a genuinely different rig remounts
              // this fresh — `autoEdit` must only ever fire once per rig.
              key={context.bindingId}
              bindingId={context.bindingId}
              path={context.path}
              name={context.name}
              onOpenPath={onOpenPath}
              onOpenFolder={onOpenFolder}
              autoEdit={autoEditRigName}
              onAutoEditHandled={onAutoEditRigNameHandled}
            />
            {/* Feedback round 3: Share belongs WITH the rig it shares —
                beside the name, not in the account cluster where its
                avatar stack collided with the user's own avatar. */}
            <span className="ml-1.5 [-webkit-app-region:no-drag]">{shareSlot}</span>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {/* Feedback round 4: no account avatar here — the identity surface
            lives in Settings, and the pill beside Share's own avatar stack
            read as a second, mystery identity. */}
        {layoutSlot}
        {/* Invites addressed to me — renders nothing signed out; accent
            count dot only when invites exist (a live indicator, within the
            accent budget). Sits between the avatar and the gear. */}
        <InvitesBell onOpenPath={onOpenPath} />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => onOpenSettings(updateReady)}
                aria-label="Settings"
                className="relative flex size-7 items-center justify-center rounded-control text-text-secondary transition-colors hover:bg-bg-2 hover:text-text-primary"
              >
                <SettingsIcon size={15} strokeWidth={1.5} />
                {/* Make-updates-visible round: same quiet accent-dot
                    convention `InvitesBell`'s own count badge documents
                    above — here just presence, no count, since "an update
                    is ready" isn't a quantity. */}
                {updateReady && (
                  <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent" />
                )}
              </button>
            }
          />
          <TooltipContent side="bottom">{updateReady ? 'Update ready' : 'Settings'}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

function FolderResult({
  folder,
  onOpenFolder,
  onRetryOpen,
  onCancel,
}: {
  folder: Extract<FolderState, { status: 'detecting' | 'detected' | 'error' }>;
  onOpenFolder: () => void;
  /** Re-runs the normal open flow for `path` — after sync comes on, detect finds the binding. */
  onRetryOpen: (path: string) => void;
  onCancel: () => void;
}) {
  // Accounts & rigs round (onboarding-flow-spec.md, "Accounts & rigs"): a
  // rig whose `rig_rigs` row belongs to a different, known account —
  // `detect` already stopped short of opening it (no root registered, no
  // relay errors to chase down); this is the honest stop instead of
  // pretending it's just "not a rig."
  if (folder.status === 'detected' && !folder.result.bound && folder.result.foreignAccount) {
    return (
      <ForeignAccountCard foreignAccount={folder.result.foreignAccount} onRetryOpen={onRetryOpen} onCancel={onCancel} />
    );
  }
  // Loose-ends round: a LOCAL-ONLY rig (rig.toml, no binding — see
  // `deriveUnboundDetection`) is an interstitial with a real action, not a
  // dead end. Plain non-rig folders keep the unchanged card below.
  if (folder.status === 'detected' && !folder.result.bound && folder.result.unsynced) {
    return (
      <UnsyncedRigCard
        unsynced={folder.result.unsynced}
        onRetryOpen={onRetryOpen}
        onCancel={onCancel}
      />
    );
  }
  return (
    <div className="flex w-full max-w-md flex-col gap-3 rounded-card border border-border-hairline bg-bg-1 p-5">
      <div className="font-mono text-xs break-all text-text-muted">{folder.path}</div>

      {folder.status === 'detecting' && (
        <div className="text-sm text-text-secondary">Checking…</div>
      )}

      {folder.status === 'error' && <div className="text-sm text-danger">{folder.message}</div>}

      {/* `bound: true` is handled above `App` renders instead — only the
          not-a-rig and error outcomes ever reach this card. */}
      {folder.status === 'detected' && !folder.result.bound && (
        <div className="text-sm text-text-secondary">not a rig</div>
      )}

      <button
        type="button"
        onClick={onOpenFolder}
        className="mt-1 self-start rounded-control border border-border-hairline px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-2 hover:text-text-primary"
      >
        Open Folder…
      </button>
    </div>
  );
}

/**
 * The unsynced-rig interstitial: name the rig, say honestly what syncing
 * buys (sharing, invites — and that it's what lets THIS app open the
 * workspace), and offer the real action. [Turn on sync] drives the same
 * `rig sync` driver creation uses (`rig.create.enableSync`), then re-runs
 * the normal open. Signed out, the sign-in affordance comes first; sync
 * errors (not_logged_in, the relay quota, …) surface verbatim.
 */
function UnsyncedRigCard({
  unsynced,
  onRetryOpen,
  onCancel,
}: {
  unsynced: { path: string; name: string | null };
  onRetryOpen: (path: string) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = authQuery.data?.signedIn ?? false;
  const { signIn, phase: signInPhase } = useRigSignIn(() => {
    void queryClient.invalidateQueries({ queryKey: ['rig', 'auth', 'status'] });
  });
  const name = unsynced.name ?? 'This rig';

  const turnOnSync = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.rig.create.enableSync({ dir: unsynced.path });
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      onRetryOpen(unsynced.path);
    } catch {
      setError("Couldn't turn on sync. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full max-w-md flex-col gap-3 rounded-card border border-border-hairline bg-bg-1 p-5">
      <p className="text-sm font-medium text-text-primary">{name} isn’t synced yet.</p>
      <p className="font-mono text-xs break-all text-text-muted">{unsynced.path}</p>
      <p className="text-sm text-text-secondary">
        Syncing turns on sharing, invites, and lets this app open it.
      </p>
      {!signedIn && (
        <div className="flex items-center gap-2">
          <p className="min-w-0 text-xs text-text-muted">Syncing needs your Rig account.</p>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void signIn()}
            disabled={signInPhase !== 'idle'}
          >
            {signInPhase === 'idle' ? 'Sign in' : 'Waiting…'}
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void turnOnSync()} disabled={busy || !signedIn}>
          {busy ? 'Turning on…' : 'Turn on sync'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Accounts & rigs round (onboarding-flow-spec.md, "Accounts & rigs"): the
 * honest stop for a rig bound to a different, known account —
 * `main/rig/workspace.ts`'s `detect` already refused to open it, so there
 * is no workspace to render here, only the real action (sign in as that
 * account) and a way back. Deliberately no "Turn on sync" step like
 * `UnsyncedRigCard` above — this rig is already synced, it's the SIGNED-IN
 * IDENTITY that's wrong, so signing in alone is enough; a successful
 * sign-in just re-runs `onRetryOpen`, and `detect` either opens it (signed
 * in as the right account now) or shows this card again honestly (signed
 * in as yet another account).
 */
function ForeignAccountCard({
  foreignAccount,
  onRetryOpen,
  onCancel,
}: {
  foreignAccount: { path: string; name: string | null };
  onRetryOpen: (path: string) => void;
  onCancel: () => void;
}) {
  const { signIn, phase: signInPhase } = useRigSignIn(() => onRetryOpen(foreignAccount.path));
  const name = foreignAccount.name ?? 'This rig';

  return (
    <div className="flex w-full max-w-md flex-col gap-3 rounded-card border border-border-hairline bg-bg-1 p-5">
      <p className="text-sm font-medium text-text-primary">
        {name} belongs to another account&rsquo;s workspace.
      </p>
      <p className="font-mono text-xs break-all text-text-muted">{foreignAccount.path}</p>
      <p className="text-sm text-text-secondary">Sign in as that account to sync and comment.</p>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={signInPhase !== 'idle'}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void signIn()} disabled={signInPhase !== 'idle'}>
          {signInPhase === 'idle' ? 'Sign in' : 'Waiting…'}
        </Button>
      </div>
    </div>
  );
}
