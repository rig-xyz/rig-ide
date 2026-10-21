import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect } from 'react';
import { Feed } from './feed';
import { FlyLayer } from './fly-layer';
import { HomeProvider, useHome } from './home-context';
import { Middle } from './middle';
import { Rail, type RailYou } from './rail';
import { useRealSpaces } from './use-real-spaces';
import './home-feed.css';

/**
 * The new Home (rig README §2, "Two screens: Home and Inbox"), behind
 * Settings › Advanced › Preview the new Home. Three zones: the rail (what's being done),
 * the middle (talk to Rig, or see what's open), and the Feed (what to do
 * next). It owns the whole window, traffic-light strip included; the app's
 * top bar steps aside, and you and Settings sit at the foot of the rail.
 */
export function NewHome({
  onOpenPath,
  onContinueSession,
  onOpenSettings,
  updateReady,
}: {
  onOpenPath: (path: string, opts?: { kind?: 'space' }) => void;
  onContinueSession: (path: string, sessionId: string) => void;
  onOpenSettings: (page?: 'account' | 'about') => void;
  updateReady: boolean;
}) {
  const { spaces, selfName, selfAvatarUrl } = useRealSpaces();
  const reducedMotion = useReducedMotion() ?? false;
  return (
    <HomeProvider
      realSpaces={spaces}
      selfName={selfName}
      reducedMotion={reducedMotion}
      onOpenPath={onOpenPath}
      onContinueSession={onContinueSession}
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
  const { dispatch } = useHome();
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
      <div className="min-w-0 py-2 [-webkit-app-region:drag]">
        <div className="hf-sheet relative flex h-full min-h-0 flex-col overflow-hidden rounded-[20px] border border-border-hairline bg-bg-1 [-webkit-app-region:no-drag]">
          <Middle />
        </div>
      </div>
      <Feed />
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
