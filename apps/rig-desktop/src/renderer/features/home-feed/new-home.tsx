import { useReducedMotion } from 'motion/react';
import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import { Feed } from './feed';
import { FeedDock } from './feed-dock';
import { FlyLayer } from './fly-layer';
import { HomeProvider, useHome } from './home-context';
import { Middle } from './middle';
import { Rail, type RailYou } from './rail';
import { useRealSpaces } from './use-real-spaces';
import { useRealFeed } from './use-real-feed';
import './home-feed.css';

/**
 * The new Home (rig README §2, "Two screens: Home and Inbox"), behind
 * Settings › Advanced › Preview the new Home. Three zones: the rail (what's being done),
 * the middle (talk to Rig, or see what's open), and the Feed (what to do
 * next). It owns the whole window, traffic-light strip included; the app's
 * top bar steps aside, and you and Settings sit at the foot of the rail.
 */
/** The scripted demo Home, for a dev build started with `VITE_RIG_DEMO_HOME=1`. */
const DEMO_HOME = import.meta.env.DEV && import.meta.env.VITE_RIG_DEMO_HOME === '1';

export function NewHome({
  onOpenPath,
  onContinueSession,
  onOpenSettings,
  updateReady,
  demo = DEMO_HOME,
}: {
  onOpenPath: (path: string, opts?: { kind?: 'space' }) => void;
  onContinueSession: (path: string, sessionId: string) => void;
  onOpenSettings: (page?: 'account' | 'about') => void;
  updateReady: boolean;
  /** Show the scripted demo while there is no real Feed (dev only; tests). */
  demo?: boolean;
}) {
  const { spaces, selfName: accountName, selfAvatarUrl } = useRealSpaces();
  // Rig's name for you when the account has none (a dev relay without profiles).
  const feed = useRealFeed();
  const selfName = accountName ?? (feed.kind === 'ready' ? feed.me : null);
  const reducedMotion = useReducedMotion() ?? false;
  return (
    <HomeProvider
      realSpaces={spaces}
      selfName={selfName}
      reducedMotion={reducedMotion}
      onOpenPath={onOpenPath}
      onContinueSession={onContinueSession}
      demo={demo}
    >
      <HomeLayout
        you={{ name: selfName, avatarUrl: selfAvatarUrl }}
        updateReady={updateReady}
        onOpenSettings={onOpenSettings}
      />
    </HomeProvider>
  );
}

/** Below these widths the rail, then the Feed, fold away, so the middle keeps room to read. */
const FOLD_RAIL_BELOW_PX = 1180;
const FOLD_FEED_BELOW_PX = 1060;

function useFoldBelow(px: number, fold: () => void) {
  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${px - 1}px)`);
    const apply = () => {
      if (media.matches) fold();
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [px, fold]);
}

/**
 * The rail and the Feed sit on the window's floor; the middle is a sheet laid
 * over them, its rounded corners showing they're behind it, like a drawer
 * under the page.
 */
function HomeLayout({
  you,
  updateReady,
  onOpenSettings,
}: {
  you: RailYou;
  updateReady: boolean;
  onOpenSettings: (page?: 'account' | 'about') => void;
}) {
  const { state, dispatch } = useHome();
  const folded = state.feedCollapsed;
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dockWidth, setDockWidth] = useState(0);
  const clearFocus = useCallback(() => setFocusId(null), []);
  useFoldBelow(
    FOLD_RAIL_BELOW_PX,
    useCallback(() => dispatch({ type: 'collapse', value: true }), [dispatch])
  );
  useFoldBelow(
    FOLD_FEED_BELOW_PX,
    useCallback(() => dispatch({ type: 'collapse-feed', value: true }), [dispatch])
  );

  return (
    <div className="relative grid h-full min-h-0 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)] overflow-hidden bg-bg-0 text-chat text-text-primary">
      <Rail you={you} updateReady={updateReady} onOpenSettings={onOpenSettings} />
      <div className={cn('min-w-0 py-2 [-webkit-app-region:drag]', folded && 'pr-2')}>
        <div
          // Folded, the Feed's dock hangs over the sheet's top right; the chat keeps clear of it.
          style={{ '--hf-gutter': folded ? `${dockWidth + 28}px` : '0px' } as CSSProperties}
          className="hf-sheet relative flex h-full min-h-0 flex-col overflow-hidden rounded-[20px] border border-border-hairline bg-bg-1 [-webkit-app-region:no-drag]"
        >
          <Middle />
        </div>
      </div>
      <Feed focusId={focusId} onFocused={clearFocus} onFocus={setFocusId} />
      {folded && (
        <FeedDock
          onLayout={setDockWidth}
          onOpen={(itemId) => {
            setFocusId(itemId ?? null);
            dispatch({ type: 'collapse-feed', value: false });
          }}
        />
      )}
      <GooFilter />
      <FlyLayer />
    </div>
  );
}

/** Joins the action pill and its round menu button into one drop (`.hf-goo`). */
function GooFilter() {
  return (
    <svg width="0" height="0" aria-hidden className="absolute">
      <filter
        id="hf-goo"
        x="-10%"
        y="-40%"
        width="120%"
        height="180%"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
        <feColorMatrix
          in="blur"
          mode="matrix"
          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"
          result="goo"
        />
        <feComposite in="SourceGraphic" in2="goo" operator="atop" />
      </filter>
    </svg>
  );
}
