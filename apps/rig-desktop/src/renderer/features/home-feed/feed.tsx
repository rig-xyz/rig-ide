import { PanelRightClose } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { IconButton, Kicker } from './bits';
import { CatchUpStrip } from './catch-up-strip';
import { ConnectorsView } from './connectors-view';
import { ClaudeOnIt, RunFooter, SetAside } from './feed-background';
import { FeedNotice, FeedStale } from './feed-notice';
import { FeedRow, IgnoredRow } from './feed-row';
import { useHome } from './home-context';
import type { FeedEntry } from './store';

/**
 * Right: the Feed, what needs to happen next, action first. Two groups, Needs
 * you and Up next; every item is a full-width row whose button names the one
 * thing that will happen (Reply, Start session, Create space, Open). Acting
 * on one moves it into the rail.
 */

export function Feed({
  focusId,
  onFocused,
  onFocus,
}: {
  /** An item to bring into view as the Feed opens (a pill clicked in the folded dock). */
  focusId?: string | null;
  onFocused?: () => void;
  /** Brings an item into view (from the Connectors side). */
  onFocus?: (itemId: string | null) => void;
}) {
  const { state, dispatch, counts, connectors, feedStatus, demo } = useHome();
  const panel = state.panel;
  // Outside the demo: why there are no cards (signed out, can't reach), or a shown Feed gone stale.
  const notice =
    demo || feedStatus.kind === 'ready' || feedStatus.kind === 'loading' || (feedStatus.kind === 'unreachable' && state.feed.length)
      ? null
      : feedStatus;
  const stale = !demo && feedStatus.kind === 'unreachable' && state.feed.length > 0;
  const live = state.fromRelay && !notice;
  const checking = connectors.connectors.some((c) => c.checking);
  const needs = state.feed.filter((e) => e.item.group === 'needs_you');
  const next = state.feed.filter((e) => e.item.group === 'up_next');
  const folded = state.feedCollapsed;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (folded || panel !== 'feed' || !focusId) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-feed-id="${CSS.escape(focusId)}"]`
    );
    row?.scrollIntoView({ block: 'center' });
    row?.classList.remove('hf-flash');
    void row?.offsetWidth;
    row?.classList.add('hf-flash');
    onFocused?.();
  }, [folded, panel, focusId, onFocused]);

  return (
    <aside
      aria-label="Feed"
      aria-hidden={folded || undefined}
      // Sized to the window: wide enough to read a proposal, never more than 448px. Folded, it
      // becomes the dock over the sheet (`feed-dock.tsx`) and gives the sheet its width.
      style={{ width: folded ? 0 : 'clamp(360px, 31vw, 448px)' }}
      className="hf-rail flex min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {!folded && (
        <>
          <div className="flex h-[52px] shrink-0 items-center gap-2.5 pr-3 pl-5 [-webkit-app-region:drag]">
            <PanelSwitch
              panel={panel}
              other={state.fromRelay ? null : 'Connectors'}
              needsYou={counts.needsYou}
              checking={checking}
              onChange={(next) => dispatch({ type: 'panel', panel: next })}
            />
            <span className="flex-1" />
            <IconButton
              label="Fold the Feed"
              dir="right"
              onClick={() => dispatch({ type: 'collapse-feed', value: true })}
            >
              <PanelRightClose className="size-[15px]" strokeWidth={1.6} />
            </IconButton>
          </div>
          {panel === 'connectors' && !state.fromRelay ? (
            <div className="relative min-h-0 min-w-[360px] flex-1 overflow-x-hidden overflow-y-auto">
              <ConnectorsView
                onOpenFeedItem={(itemId) => {
                  dispatch({ type: 'panel', panel: 'feed' });
                  onFocus?.(itemId);
                }}
              />
            </div>
          ) : (
            <div
              ref={listRef}
              className="relative min-h-0 min-w-[360px] flex-1 overflow-x-hidden overflow-y-auto pb-5"
            >
              {notice ? (
                <FeedNotice status={notice} />
              ) : (
                <>
                  {stale && <FeedStale />}
                  {live && <CatchUpStrip needsYou={counts.needsYou} />}
                  <Group title="Needs you" tone="warn" entries={needs} />
                  <Group title={state.fromRelay ? 'Claude can take' : 'Up next'} tone="accent" entries={next} />
                  {live && <ClaudeOnIt withHead={!next.length} />}
                  {!needs.length && !next.length && feedStatus.kind !== 'loading' && (
                    <p className="px-5 py-2.5 text-sm text-text-muted">Nothing waiting on you.</p>
                  )}
                  {live && <SetAside />}
                </>
              )}
            </div>
          )}
          {live && feedStatus.kind === 'ready' && <RunFooter />}
        </>
      )}
    </aside>
  );
}

/**
 * Feed or Connectors: what needs to happen next, or your connectors at work.
 * Feed carries an amber dot while something needs you; Connectors shows Claude
 * searching while a check runs, so the background work shows from either side.
 */
function PanelSwitch({
  panel,
  other,
  needsYou,
  checking,
  onChange,
}: {
  panel: 'feed' | 'connectors';
  /** The other side: Connectors in the demo; none with the real Feed, whose background work shows at its foot. */
  other: string | null;
  needsYou: number;
  checking: boolean;
  onChange: (panel: 'feed' | 'connectors') => void;
}) {
  const tab = (id: 'feed' | 'connectors', label: string, mark: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={panel === id}
      onClick={() => onChange(id)}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full px-3 text-sm transition-[background-color,color,box-shadow]',
        panel === id
          ? 'hf-switch-on font-medium text-text-primary'
          : 'text-text-secondary hover:text-text-primary'
      )}
    >
      {label}
      {mark}
    </button>
  );
  return (
    <div
      role="tablist"
      aria-label="Right panel"
      className="hf-switch inline-flex items-center gap-0.5 rounded-full p-[3px] [-webkit-app-region:no-drag]"
    >
      {tab(
        'feed',
        'Feed',
        needsYou > 0 && (
          <span
            aria-label={`${needsYou} need you`}
            className="size-1.5 rounded-full bg-status-warn shadow-[0_0_0_2px_color-mix(in_oklab,var(--status-warn)_25%,transparent)]"
          />
        )
      )}
      {other !== null &&
        tab('connectors', other, checking && <DotMatrix state="searching" size="sm" label="Checking" />)}
    </div>
  );
}

function Group({
  title,
  tone,
  entries,
}: {
  title: string;
  tone: 'warn' | 'accent';
  entries: FeedEntry[];
}) {
  const { reducedMotion } = useHome();
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {entries.length > 0 && (
        <motion.div
          key={`head-${title}`}
          layout={!reducedMotion}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.2 }}
          className="px-5 pt-3.5 pb-1.5"
        >
          <Kicker className="flex items-center gap-2">
            <span aria-hidden className="hf-group-dot" data-tone={tone} />
            {title}
          </Kicker>
        </motion.div>
      )}
      {entries.map((entry) => (
        <motion.div
          key={entry.item.id}
          layout={!reducedMotion}
          exit={{ opacity: 0, x: 16, scale: 0.98 }}
          transition={{ duration: reducedMotion ? 0 : 0.3, ease: [0.2, 0.8, 0.2, 1] }}
          className="relative"
        >
          {entry.ignored ? <IgnoredRow entry={entry} /> : <FeedRow entry={entry} />}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

