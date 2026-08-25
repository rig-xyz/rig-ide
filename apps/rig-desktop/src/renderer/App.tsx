import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCheck,
  ChevronRight,
  Home as HomeIcon,
  MessageSquare,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BROWSER_STATE,
  isFileView,
  popToBrowser,
  pushFile,
  type ArtifactPanelState,
} from '@renderer/features/artifact/artifact-panel-stack';
import { ArtifactView } from '@renderer/features/artifact/artifact-view';
import { ChatPanel } from '@renderer/features/chat/chat-panel';
import { Home } from '@renderer/features/home/home';
import { Onboarding } from '@renderer/features/onboarding/onboarding';
import { deriveOnboardingSteps } from '@renderer/features/onboarding/onboarding-state';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { UserPill } from '@renderer/features/rig-account/user-pill';
import { NewMenu } from '@renderer/features/rig-import/add-menu';
import { ImportDocDialog } from '@renderer/features/rig-import/import-doc-dialog';
import { RigShareButton } from '@renderer/features/rig-share/rig-share-button';
import { InvitesBell } from '@renderer/features/shell/invites-bell';
import { RigSwitcher } from '@renderer/features/shell/rig-switcher';
import { SettingsModal } from '@renderer/features/shell/settings-modal';
import { deriveTopbarContext, type TopbarContext } from '@renderer/features/shell/topbar-context';
import { isUpdateReady, shouldAnnounceUpdate } from '@renderer/features/shell/update-status';
import { useUpdateStatus } from '@renderer/features/shell/use-update-status';
import { FileTree } from '@renderer/features/workspace/file-tree';
import { ActiveFiles } from '@renderer/features/workspace/active-files';
import { RigPeopleCard } from '@renderer/features/workspace/rig-people-card';
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
  DEFAULT_FILE_TREE_VIEW,
  type FileTreeView,
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

function readStoredChatCollapsed(): boolean {
  try {
    return localStorage.getItem(CHAT_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
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
  const [nav, setNav] = useState<ArtifactPanelState>(BROWSER_STATE);
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(readStoredChatCollapsed);
  const [chatWidth, setChatWidth] = useState<number>(readStoredChatWidth);
  const chatWidthRef = useRef(chatWidth);
  chatWidthRef.current = chatWidth;
  // Round H2's onboarding gate — null until the settings handshake below
  // resolves at least once; App renders NOTHING (not the wizard, not the
  // normal shell) while this is null, so a fresh boot never flashes the
  // wrong one before the real value is known.
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState<boolean | null>(null);
  // File-navigator redesign: the tree's "Show system files" toggle —
  // reconciled from main alongside the other plain preferences below,
  // rather than a second settings subscription in `FileBrowser`/`FileTree`.
  const [showSystemFiles, setShowSystemFiles] = useState(false);
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
      applyThemeFromSettings(settings.theme);
      if (settings.chatPanelWidth !== null) {
        setChatWidth(clamp(settings.chatPanelWidth, CHAT_WIDTH_MIN, CHAT_WIDTH_MAX));
      }
      setChatCollapsed(settings.chatPanelCollapsed);
      setHasSeenOnboarding(settings.hasSeenOnboarding);
      setShowSystemFiles(settings.showSystemFiles);
    };

    rpc.rig.settings
      .importLegacy(legacy)
      .then(reconcile)
      .catch(() => {});
    return events.on(rigSettingsChangedChannel, reconcile);
    // `applyThemeFromSettings` is stable (useTheme's own useCallback has
    // empty deps) — listed for exhaustive-deps honesty, not because it
    // ever changes.
  }, [applyThemeFromSettings]);

  // Shared by the Open Folder… dialog and the native Open Recent flow below
  // — same detect-and-bind path either way, so a recent rig opens exactly
  // like one picked by hand. Single window, v1: this always replaces
  // whatever rig is currently open rather than spawning a second window.
  const openPath = useCallback(async (picked: string, opts?: { activeSessionId?: string }) => {
    const requestToken = openPathRequests.current.begin();
    setNav(BROWSER_STATE);
    setFolder({ status: 'detecting', path: picked });
    setPendingActiveSessionId(opts?.activeSessionId ?? null);
    try {
      const result = await rpc.rig.workspace.detect(picked);
      if (!openPathRequests.current.isCurrent(requestToken)) return;
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
          name: folder.result.name,
          bindingId: folder.result.bindingId,
        }
      : null;

  // A different rig opened (or the folder closed): the nav stack belongs to
  // the previous root.
  useEffect(() => {
    setNav(BROWSER_STATE);
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
    if (!root) return;
    void rpc.rig.files.watch(root);
    const off = events.on(rigFileChangeChannel, ({ root: changedRoot }) => {
      if (changedRoot !== root) return;
      void rpc.rig.workspace.readName(root).then((name) => {
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
      void rpc.rig.files.unwatch(root);
    };
  }, [bound?.root]);

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
  }, []);

  // Round (beyond-markdown): every file opens now — `ArtifactView` itself
  // routes on real type detection (markdown/text/image/unsupported, see
  // `file-type.ts`), down to a designed empty state for anything it
  // genuinely can't preview. This used to gate on `.md` and toast "No
  // preview yet" for everything else; that blanket refusal is gone.
  const openFile = useCallback((absPath: string) => {
    setNav(pushFile(absPath));
  }, []);

  // Card rail round (§3): a card click opens the file AND arms a reveal for
  // when the user comes back to the tree — the two views are mutually
  // exclusive panels, so "reveal" can't happen at the same instant as
  // "open." `pushFile`'s own revealPath rides along on the `'file'` state
  // until `backToBrowser` below carries it into the `popToBrowser` call
  // that actually returns to the tree.
  const openFileAndReveal = useCallback((absPath: string, relPath: string) => {
    setNav(pushFile(absPath, relPath));
  }, []);

  // Carries a `'file'` state's own stashed revealPath (see `openFileAndReveal`
  // above) forward into the browser it returns to — a plain open (no reveal
  // armed) still returns with nothing to reveal, exactly as before.
  const backToBrowser = useCallback(() => {
    setNav((current) => popToBrowser(isFileView(current) ? current.revealPath : null));
  }, []);
  const navigateToFolder = useCallback((relPath: string) => setNav(popToBrowser(relPath)), []);

  // Esc pops the artifact panel back to the file browser — but only when
  // focus isn't inside something that already owns Escape (the CM6 editor,
  // the comment composer's mention dropdown — see comments-margin.tsx).
  // ArtifactView's behavior contract is frozen, so this lives here rather
  // than inside it.
  useEffect(() => {
    if (!isFileView(nav)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('textarea, input, [contenteditable="true"], .cm-editor')
      ) {
        return;
      }
      backToBrowser();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nav, backToBrowser]);

  const toggleShowSystemFiles = useCallback(() => {
    setShowSystemFiles((current) => {
      const next = !current;
      void rpc.rig.settings.set({ showSystemFiles: next });
      return next;
    });
  }, []);

  const toggleChatCollapsed = useCallback(() => {
    setChatCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(CHAT_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // localStorage unavailable — collapse state just won't persist.
      }
      void rpc.rig.settings.set({ chatPanelCollapsed: next });
      return next;
    });
  }, []);

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

  const onboardingSteps =
    hasSeenOnboarding === null || authStatusQuery.isLoading
      ? null
      : deriveOnboardingSteps({
          hasSeenOnboarding,
          signedIn: authStatusQuery.data?.signedIn ?? false,
        });

  const onOnboardingComplete = useCallback(() => {
    setHasSeenOnboarding(true);
    void rpc.rig.settings.set({ hasSeenOnboarding: true });
  }, []);

  // Nothing known yet (settings/auth-status still loading) — render
  // nothing rather than guess; the wizard and the normal shell are both
  // genuinely wrong answers for a frame here.
  if (onboardingSteps === null) return null;
  if (onboardingSteps.length > 0) {
    return <Onboarding steps={onboardingSteps} onComplete={onOnboardingComplete} />;
  }

  return (
    <div className="relative flex h-full flex-col">
      <Topbar
        context={deriveTopbarContext(bound)}
        variant={bound ? 'rig' : 'home'}
        scrolled={!bound && mainScrolled}
        onGoHome={goHome}
        onOpenSettings={openSettings}
        onOpenPath={openPath}
        onOpenFolder={openFolder}
        updateReady={isUpdateReady(updateStatus.state)}
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
        <div className="flex min-h-0 flex-1 pt-10">
          {chatCollapsed ? (
            // A slim strip in the chat panel's own spot, not a topbar
            // button: collapsing doesn't relocate where chat lives, it just
            // narrows it — the reopen control belongs where the eye already
            // returns to. The chat glyph (not the generic panel-toggle
            // icon) plus a real hover tooltip is the legible part.
            <div
              style={{ order: CHAT_PANEL_ORDER }}
              className="flex w-10 shrink-0 flex-col items-center border-r border-border-hairline bg-bg-1 py-2"
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={toggleChatCollapsed}
                      aria-label="Open chat"
                    >
                      <MessageSquare className="size-3.5" strokeWidth={1.5} />
                    </Button>
                  }
                />
                <TooltipContent side="right">Open chat</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <>
              <div
                style={{ order: CHAT_PANEL_ORDER, width: chatWidth }}
                className="flex shrink-0 flex-col overflow-hidden bg-bg-1"
              >
                <ChatPanel
                  root={bound.root}
                  bindingId={bound.bindingId}
                  name={bound.name}
                  initialActiveSessionId={pendingActiveSessionId}
                  onOpenFile={openFile}
                  onToggleCollapse={toggleChatCollapsed}
                />
              </div>
              {/* The handle IS the panel divider (no separate border-r on the
                  chat wrapper above) — a wide, easy-to-grab hit area with a
                  thin centered line so it reads as a hairline at rest and
                  only widens visually on hover/drag. */}
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
            </>
          )}

          <div
            style={{ order: ARTIFACT_PANEL_ORDER }}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {isFileView(nav) ? (
              <ArtifactView
                key={nav.path}
                root={bound.root}
                path={nav.path}
                onClose={backToBrowser}
                onNavigateFolder={navigateToFolder}
              />
            ) : (
              <FileBrowser
                root={bound.root}
                bindingId={bound.bindingId}
                name={bound.name}
                revealPath={nav.revealPath}
                onOpenFile={openFile}
                onOpenFileAndReveal={openFileAndReveal}
                justAttachedSyncing={bound.root === syncingRoot}
                showSystemFiles={showSystemFiles}
                onToggleShowSystemFiles={toggleShowSystemFiles}
              />
            )}
          </div>
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
              bindingId={context.bindingId}
              name={context.name}
              onOpenPath={onOpenPath}
              onOpenFolder={onOpenFolder}
            />
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <UserPill compact />
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
    const result = await rpc.rig.create.enableSync({ dir: unsynced.path });
    setBusy(false);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    onRetryOpen(unsynced.path);
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
 * Root level of the artifact panel's nested nav (`docs/collab-pivot-spec.md`
 * §4.2, restructured per the two-panel brief): the real file tree of the
 * opened rig, full-panel rather than a persistent sidebar. Reuses `FileTree`
 * as-is — it was already unstyled-for-width (file rows in a flex column, no
 * fixed width of its own; the old `w-60` lived on the sidebar `<aside>` this
 * replaces) — just wrapped in a full-height, full-width container with the
 * same rig-name header the old sidebar had.
 *
 * Header-dedup round, take 3: no navigation in this header at all — the
 * topbar's mini-breadcrumb owns up-navigation (its house button) AND rig
 * switching now (`RigSwitcher`), so this row carries only the rig-level
 * actions: Share and Add. Path crumbs only ever appear in `ArtifactView`'s
 * breadcrumb (folders › file).
 *
 * Add-menu round: "Import" (a single click straight into the Google
 * Docs/.docx dialog) became "Add" — new file, Google Docs link, or any
 * other file, one menu (`AddMenu`). "Open…" moved off this header entirely
 * — the topbar's `RigSwitcher` carries the native-picker escape hatch now.
 */
function FileBrowser({
  root,
  bindingId,
  name,
  revealPath,
  onOpenFile,
  onOpenFileAndReveal,
  justAttachedSyncing,
  showSystemFiles,
  onToggleShowSystemFiles,
}: {
  root: string;
  /** File-navigator redesign (§4, seen-state): identifies this rig for `rig_seen_files`. */
  bindingId: string;
  name: string | null;
  revealPath: string | null;
  onOpenFile: (absPath: string) => void;
  /** Suggested group (§3.2): opens AND arms a tree reveal for the file's return trip — `SuggestedFiles`' own click handler. */
  onOpenFileAndReveal: (absPath: string, relPath: string) => void;
  /** First-sync round — see `FileTree`'s own prop comment. */
  justAttachedSyncing: boolean;
  /** File-navigator redesign: System entries (`rig.toml`, `.rig/`, dotfiles) stay hidden until this is true. */
  showSystemFiles: boolean;
  onToggleShowSystemFiles: () => void;
}) {
  const [importOpen, setImportOpen] = useState(false);
  // v2 round (§3.1): the header search field's live query — ephemeral UI
  // state, not persisted (unlike `view` below), the same way a Finder
  // window's search field forgets itself on close.
  const [search, setSearch] = useState('');
  // v2 round (§3.1): the header's contextual "N new" chip — CONTENT-ONLY
  // (`FileTree`'s own `onUnseenCountChange`), independent of the current
  // search/sort/filter view.
  const [unseenCount, setUnseenCount] = useState(0);

  // File-navigator redesign (§5, re-specced §3.4): the tree's own sort/
  // filter choice, per rig — owned here (not inside `FileTree`/`FileSortMenu`
  // separately) because both need the SAME value in the same render pass:
  // the menu shows which option is checked, the tree applies it, and the
  // chip toggles `filter` directly. Same fetch-then-subscribe shape as
  // `showSystemFiles` above it in `App`, scoped to this rig's
  // `fileTreeViewByRig[bindingId]` the way `pinnedPathsByRig` already is in
  // `file-tree.tsx`/`suggested-files.tsx`.
  const [view, setView] = useState<FileTreeView>(DEFAULT_FILE_TREE_VIEW);
  useEffect(() => {
    let alive = true;
    void rpc.rig.settings.get().then((settings) => {
      if (alive) setView(settings.fileTreeViewByRig[bindingId] ?? DEFAULT_FILE_TREE_VIEW);
    });
    const off = events.on(rigSettingsChangedChannel, (settings) => {
      setView(settings.fileTreeViewByRig[bindingId] ?? DEFAULT_FILE_TREE_VIEW);
    });
    return () => {
      alive = false;
      off();
    };
  }, [bindingId]);

  const onChangeView = useCallback(
    (next: FileTreeView) => {
      setView(next);
      void rpc.rig.settings.set({ fileTreeViewByRig: { [bindingId]: next } });
    },
    [bindingId]
  );

  // v2 round (§3.1): the "N new" chip — click filters to unseen, click
  // again clears. Reuses the same persisted `view.filter` the sort menu's
  // own choices go through, so the chip and a future sort-menu equivalent
  // can never disagree about the current filter state.
  // Clearing from the chip needs the rig's full file list, which only the
  // tree has fetched — it hands its own "mark everything seen" action up
  // here rather than this component issuing a second listing call.
  const [markAllSeen, setMarkAllSeen] = useState<(() => void) | null>(null);
  const onMarkAllSeen = useCallback(() => markAllSeen?.(), [markAllSeen]);

  const toggleUnseenChip = useCallback(() => {
    onChangeView({ ...view, filter: view.filter === 'unseen' ? 'all' : 'unseen' });
  }, [view, onChangeView]);

  // Seen-state (§4): `FileTree`'s own row clicks mark themselves seen
  // directly (it already has each row's relPath). Everything else that can
  // open a file from this header — `AddMenu`'s "New file", the import
  // dialog — hands back only an absPath, so this one wrapper derives the
  // relPath the same way `breadcrumb.ts` does and marks it too: a
  // just-created or just-imported file the user is looking at right now
  // shouldn't show up as "unseen" the next time they look at the tree.
  const handleOpenFile = useCallback(
    (absPath: string) => {
      const relPath = relPathFromRoot(root, absPath);
      if (relPath) void rpc.rig.seenState.markSeen({ bindingId, relPath });
      onOpenFile(absPath);
    },
    [root, bindingId, onOpenFile]
  );

  // Suggested group: a row click already knows its own relPath (no
  // derivation needed) — mark it seen the same way every other open does,
  // then open AND reveal.
  const handleOpenFileFromCard = useCallback(
    (absPath: string, relPath: string) => {
      void rpc.rig.seenState.markSeen({ bindingId, relPath });
      onOpenFileAndReveal(absPath, relPath);
    },
    [bindingId, onOpenFileAndReveal]
  );

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto">
      <div className="border-border-hairline flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="relative flex min-w-0 max-w-56 flex-1 items-center">
            <Search className="text-text-muted pointer-events-none absolute left-2 size-3.5" strokeWidth={1.5} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search files"
              className="border-border-hairline bg-bg-1 text-text-primary placeholder:text-text-muted focus:border-border-strong w-full rounded-control border py-1.5 pr-2 pl-7 text-xs transition-colors outline-none"
            />
          </div>
          {unseenCount > 0 && (
            /*
              Two separate controls, not one that mutates on hover: the
              chip filters to what is new, and a distinct button beside it
              clears. An affordance that grows out of another one moves the
              thing you were aiming at, which is why the earlier version
              felt broken.
            */
            <>
              <button
                type="button"
                onClick={toggleUnseenChip}
                aria-pressed={view.filter === 'unseen'}
                title={view.filter === 'unseen' ? 'Show everything' : 'Show only what is new'}
                className={cn(
                  'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                  view.filter === 'unseen'
                    ? 'bg-accent text-accent-ink'
                    : 'bg-accent-subtle text-accent hover:opacity-80'
                )}
              >
                {unseenCount} new
              </button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={onMarkAllSeen}
                      aria-label="Mark all as seen"
                      className="text-text-muted hover:bg-bg-2 hover:text-text-primary rounded-control flex size-6 shrink-0 items-center justify-center transition-colors"
                    >
                      <CheckCheck className="size-3.5" strokeWidth={1.5} />
                    </button>
                  }
                />
                <TooltipContent side="bottom">Mark all as seen</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NewMenu
            root={root}
            onOpenFile={handleOpenFile}
            onOpenImportDialog={() => setImportOpen(true)}
          />
          <RigShareButton root={root} name={name} />
        </div>
      </div>
      <ImportDocDialog
        root={root}
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={handleOpenFile}
      />
      <RigPeopleCard root={root} bindingId={bindingId} />
      <ActiveFiles root={root} bindingId={bindingId} onOpenFile={handleOpenFileFromCard} />
      <FileTree
        root={root}
        bindingId={bindingId}
        activePath={null}
        revealPath={revealPath}
        onOpenFile={onOpenFile}
        justAttachedSyncing={justAttachedSyncing}
        showSystemFiles={showSystemFiles}
        sort={view.sort}
        filter={view.filter}
        search={search}
        onChangeSort={(next) => onChangeView({ ...view, sort: next })}
        onToggleShowSystemFiles={onToggleShowSystemFiles}
        onUnseenCountChange={setUnseenCount}
        onProvideMarkAllSeen={setMarkAllSeen}
      />
    </div>
  );
}

