import { useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import { Feed } from './feed';
import { FlyLayer } from './fly-layer';
import { HomeProvider, useHome } from './home-context';
import { Middle } from './middle';
import { Rail } from './rail';
import { useRealSpaces } from './use-real-spaces';
import './home-feed.css';

/**
 * The new Home (rig README §2, "Two screens: Home and Inbox"), behind
 * Settings › Advanced › Preview the new Home. Three zones: the rail (what's being done),
 * the middle (talk to Rig, or see what's open), and the Feed (what to do
 * next). It owns the whole window, traffic-light strip included; `headerEnd`
 * is the app's Activity and Settings buttons, which sit at the Feed's top.
 */
export function NewHome({
  onOpenPath,
  onContinueSession,
  headerEnd,
}: {
  onOpenPath: (path: string, opts?: { kind?: 'space' }) => void;
  onContinueSession: (path: string, sessionId: string) => void;
  headerEnd?: ReactNode;
}) {
  const { spaces, selfName } = useRealSpaces();
  const reducedMotion = useReducedMotion() ?? false;
  return (
    <HomeProvider
      realSpaces={spaces}
      selfName={selfName}
      reducedMotion={reducedMotion}
      onOpenPath={onOpenPath}
      onContinueSession={onContinueSession}
    >
      <HomeLayout headerEnd={headerEnd} />
    </HomeProvider>
  );
}

/** Below this width the rail folds to its icons, so the middle keeps room to read. */
const FOLD_RAIL_BELOW_PX = 1180;

function HomeLayout({ headerEnd }: { headerEnd?: ReactNode }) {
  const { state, dispatch } = useHome();
  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${FOLD_RAIL_BELOW_PX - 1}px)`);
    const apply = () => {
      if (media.matches) dispatch({ type: 'collapse', value: true });
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [dispatch]);

  return (
    <div className="relative grid h-full min-h-0 grid-cols-[auto_minmax(0,1fr)_448px] grid-rows-[minmax(0,1fr)] overflow-hidden bg-bg-0 text-chat text-text-primary">
      <Rail />
      <Middle />
      <Feed headerEnd={headerEnd} />
      <GooFilter />
      <FlyLayer />
      <Toast toast={state.toast} />
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

const TOAST_MS = 2600;

function Toast({ toast }: { toast: { text: string; n: number } | null }) {
  const [shown, setShown] = useState<{ text: string; n: number } | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setShown(toast);
    setVisible(true);
    const t = setTimeout(() => setVisible(false), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <div
      role="status"
      className={cn(
        'bg-text-primary text-bg-1 pointer-events-none absolute bottom-[18px] left-1/2 z-30 max-w-[calc(100%-32px)] -translate-x-1/2 rounded-[9px] px-3.5 py-2 text-sm transition-[opacity,transform] duration-[250ms] ease-out motion-reduce:transition-none',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-3.5 opacity-0'
      )}
    >
      {shown?.text}
    </div>
  );
}
