import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArtifactView } from '@renderer/features/artifact/artifact-view';
import {
  BROWSER_STATE,
  isFileView,
  popToBrowser,
  pushFile,
  type ArtifactPanelState,
} from '@renderer/features/artifact/artifact-panel-stack';
import { ChatPanel } from '@renderer/features/chat/chat-panel';
import { Home } from '@renderer/features/home/home';
import { Onboarding } from '@renderer/features/onboarding/onboarding';
import { deriveOnboardingSteps } from '@renderer/features/onboarding/onboarding-state';
import { UserPill } from '@renderer/features/rig-account/user-pill';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { AddMenu } from '@renderer/features/rig-import/add-menu';
import { ImportDocDialog } from '@renderer/features/rig-import/import-doc-dialog';
import { RigShareButton } from '@renderer/features/rig-share/rig-share-button';
import { InvitesBell } from '@renderer/features/shell/invites-bell';
import { SettingsModal } from '@renderer/features/shell/settings-modal';
import { RigSwitcher } from '@renderer/features/shell/rig-switcher';
import { deriveTopbarContext, type TopbarContext } from '@renderer/features/shell/topbar-context';
import { FileTree } from '@renderer/features/workspace/file-tree';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { events, rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { ChevronRight, Home as HomeIcon, MessageSquare, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredChatWidth(): number {
  const fallback = clamp(window.innerWidth * CHAT_WIDTH_DEFAULT_RATIO, CHAT_WIDTH_MIN, CHAT_WIDTH_MAX);
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
  // Polish round: scroll-aware topbar — see `Topbar`'s own comment for why
  // only `<main>` (Home/`FolderResult`) ever sets this away from false.
  const [mainScrolled, setMainScrolled] = useState(false);
  const [folder, setFolder] = useState<FolderState>({ status: 'empty' });
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
    };

    rpc.rig.settings.importLegacy(legacy).then(reconcile).catch(() => {});
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
    setNav(BROWSER_STATE);
    setFolder({ status: 'detecting', path: picked });
    setPendingActiveSessionId(opts?.activeSessionId ?? null);
    try {
      const result = await rpc.rig.workspace.detect(picked);
      setFolder({ status: 'detected', path: picked, result });
    } catch (error) {
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
      ? { root: folder.result.workspaceRoot, name: folder.result.name, bindingId: folder.result.bindingId }
      : null;

  // A different rig opened (or the folder closed): the nav stack belongs to
  // the previous root.
  useEffect(() => {
    setNav(BROWSER_STATE);
  }, [bound?.root]);

  // Round F: there was no way back from a workspace to the home screen —
  // just closes the rig view (`folder` back to `'empty'`, which is exactly
  // the state `Home` renders under). Sessions/tabs round-trip for free:
  // `ChatPanel` persists `lastOpenTabsByRig[bindingId]` independently of
  // `folder`, so reopening the SAME rig later (via `openPath`, from `Home`'s
  // RIGS row or a fresh Open Folder…) restores them exactly as left, without
  // this needing to touch that state at all.
  const goHome = useCallback(() => {
    setFolder({ status: 'empty' });
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

  const backToBrowser = useCallback(() => setNav(popToBrowser()), []);
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
      setChatWidth(clamp(startWidth + sign * (moveEvent.clientX - startX), CHAT_WIDTH_MIN, CHAT_WIDTH_MAX));
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
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPath={openPath}
        onOpenFolder={openFolder}
      />
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        themePreference={themePreference}
        onSetThemePreference={setThemePreference}
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
              className="border-border-hairline bg-bg-1 flex w-10 shrink-0 flex-col items-center border-r py-2"
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" onClick={toggleChatCollapsed} aria-label="Open chat">
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
                className="bg-bg-1 flex shrink-0 flex-col overflow-hidden"
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
                <div className="bg-border-hairline group-hover:bg-accent/50 group-active:bg-accent/70 absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors" />
              </div>
            </>
          )}

          <div style={{ order: ARTIFACT_PANEL_ORDER }} className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                name={bound.name}
                revealPath={nav.revealPath}
                onOpenFile={openFile}
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
            <Home onOpenFolder={openFolder} onOpenPath={openPath} onContinueSession={continueSession} />
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
  onOpenSettings: () => void;
  /** Threaded down to `InvitesBell` — its post-accept "Set up locally" opens the result the same way every other "open a rig" entry point does. Also `RigSwitcher`'s own row clicks. */
  onOpenPath: (path: string) => void;
  /** `RigSwitcher`'s "Open folder…" escape hatch — the native picker, same `openFolder` flow every other entry point uses. */
  onOpenFolder: () => void;
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
      <div className="text-text-muted flex min-w-0 items-center gap-1.5 text-xs">
        {context.kind === 'rig' && (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onGoHome}
                    aria-label="Home"
                    className="text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex size-6 shrink-0 items-center justify-center transition-colors [-webkit-app-region:no-drag]"
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
                onClick={onOpenSettings}
                aria-label="Settings"
                className="text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex size-7 items-center justify-center transition-colors"
              >
                <SettingsIcon size={15} strokeWidth={1.5} />
              </button>
            }
          />
          <TooltipContent side="bottom">Settings</TooltipContent>
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
    <div className="border-border-hairline bg-bg-1 rounded-card flex w-full max-w-md flex-col gap-3 border p-5">
      <div className="text-text-muted font-mono text-xs break-all">{folder.path}</div>

      {folder.status === 'detecting' && (
        <div className="text-text-secondary text-sm">Checking…</div>
      )}

      {folder.status === 'error' && <div className="text-danger text-sm">{folder.message}</div>}

      {/* `bound: true` is handled above `App` renders instead — only the
          not-a-rig and error outcomes ever reach this card. */}
      {folder.status === 'detected' && !folder.result.bound && (
        <div className="text-text-secondary text-sm">not a rig</div>
      )}

      <button
        type="button"
        onClick={onOpenFolder}
        className="border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control mt-1 self-start border px-3 py-1.5 text-sm transition-colors"
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
    <div className="border-border-hairline bg-bg-1 rounded-card flex w-full max-w-md flex-col gap-3 border p-5">
      <p className="text-text-primary text-sm font-medium">{name} isn’t synced yet.</p>
      <p className="text-text-muted font-mono text-xs break-all">{unsynced.path}</p>
      <p className="text-text-secondary text-sm">
        Syncing turns on sharing, invites, and lets this app open it.
      </p>
      {!signedIn && (
        <div className="flex items-center gap-2">
          <p className="text-text-muted min-w-0 text-xs">Syncing needs your Rig account.</p>
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
      {error && <p className="text-danger text-xs">{error}</p>}
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
  name,
  revealPath,
  onOpenFile,
}: {
  root: string;
  name: string | null;
  revealPath: string | null;
  onOpenFile: (absPath: string) => void;
}) {
  const [importOpen, setImportOpen] = useState(false);
  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto">
      <div className="border-border-hairline flex h-10 shrink-0 items-center justify-end border-b px-3">
        <div className="flex shrink-0 items-center gap-2">
          <AddMenu root={root} onOpenFile={onOpenFile} onOpenImportDialog={() => setImportOpen(true)} />
          <RigShareButton root={root} name={name} />
        </div>
      </div>
      <ImportDocDialog
        root={root}
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onOpenFile}
      />
      <FileTree root={root} activePath={null} revealPath={revealPath} onOpenFile={onOpenFile} />
    </div>
  );
}
