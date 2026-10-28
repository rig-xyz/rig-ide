import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useReducer, useRef } from 'react';
import { sourceName } from '@renderer/features/home-feed/bits';
import { FeedRowView, type MenuItem } from '@renderer/features/home-feed/feed-row';
import { chosen } from '@renderer/features/home-feed/say';
import type { FeedEntry, SentResult } from '@renderer/features/home-feed/store';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import type { FirstWinEnv } from '../env';
import { firstWinReducer, frontOf, initialFirstWin } from './first-win-model';
import './first-win.css';

/**
 * The first run's cards, on the Read stage over the field that's still
 * reading (spec Step 6, folded into Step 5): the Feed's title row with a
 * ‹ 2 of 6 › to cycle the ready cards, and the one in front as a real Feed
 * row with its answer drafted in the person's words. One click sends it or
 * starts it: that's the win, and after a moment the first run ends on Home.
 * Cards that land while Rig reads join the cycle.
 */

const MENU: MenuItem[] = [
  { key: 'another', label: 'Show me another', hint: 'Something else I found for you' },
  { key: 'later', label: 'Not now', hint: 'Hide it until tomorrow' },
  { key: 'ignore', label: 'Ignore', hint: 'Hide it; Rig learns from it' },
];

/** How long the done card stays after the win, before the first run ends on Home. */
export const WIN_HOLD_MS = 1200;

const where = (e: FeedEntry) => (e.item.source ? sourceName(e.item.source.connector) : 'Rig');

export function CardStack({
  firstWin,
  landed,
  onShown,
  onWon,
  openSession,
}: {
  firstWin: FirstWinEnv;
  /** How many cards the read has put on the Feed so far: each one reads the Feed again. */
  landed: number;
  /** The first cards showed (for step drop-off). */
  onShown?: () => void;
  /** The win, after its moment: what it sent or started. */
  onWon: (result: SentResult) => void;
  /** A started card's Open: the session in its space (which ends the first run). Null in a simulation. */
  openSession: ((root: string, sessionId: string) => void) | null;
}) {
  const [state, dispatch] = useReducer(firstWinReducer, initialFirstWin);
  const env = useRef(firstWin);
  env.current = firstWin;
  // The Feed's cards, and again each time the read puts another one up.
  useEffect(() => {
    let live = true;
    void env.current
      .cards()
      .then((items) => live && items && dispatch({ type: 'loaded', items }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [landed]);

  const shown = useRef(onShown);
  shown.current = onShown;
  const any = (state.cards?.length ?? 0) > 0;
  useEffect(() => {
    if (any) shown.current?.();
  }, [any]);

  // The win: the done card a moment, then Home.
  const won = useRef(onWon);
  won.current = onWon;
  const sent = state.won ? state.done.at(-1)?.sent : undefined;
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => won.current(sent), WIN_HOLD_MS);
    return () => clearTimeout(timer);
  }, [sent]);

  const cards = state.cards ?? [];
  const front = state.won ? undefined : frontOf(state);
  const choice = front ? chosen(front.item, front.pick) : null;
  const behind = Math.min(2, cards.length - 1);

  const run = () => {
    if (!front || !choice || front.starting) return;
    dispatch({ type: 'starting' });
    const go =
      choice.verb === 'send' || choice.verb === 'post'
        ? env.current.send(front.item, choice, front.draftEdit ?? choice.draft?.text ?? '')
        : env.current.start(front.item, choice);
    void go.then((r) =>
      dispatch(r.success ? { type: 'sent', result: r.data } : { type: 'failed', error: r.error })
    );
  };

  if (!front && !state.done.length) return null;

  const lead = state.won
    ? 'Done. Taking you to your Home: the rest of your Feed is there, and Rig keeps reading.'
    : choice?.draft
      ? front!.item.choices.length > 1
        ? 'Send it, or use the arrows on the card to see the other answers I drafted.'
        : 'Send it as it is, or change the words first.'
      : 'Start it and Claude does the work in a session; the result comes back to your Feed.';

  return (
    <div className="fw-panel flex w-[min(460px,100%)] flex-col gap-2.5" data-testid="first-win">
      <div className="flex items-center gap-3 px-1">
        <h3 className="m-0 flex-1 font-display text-[19px] leading-tight font-semibold tracking-[-0.01em] text-text-primary">
          Feed
        </h3>
        {!state.won && cards.length > 1 && (
          <div className="flex items-center gap-0.5" data-testid="first-win-cycle">
            <CycleButton label="The card before" onClick={() => dispatch({ type: 'step', by: -1 })}>
              <ChevronLeft className="size-4" strokeWidth={1.8} />
            </CycleButton>
            <span className="min-w-[3.6em] text-center text-meta text-text-muted tabular-nums" data-testid="first-win-count">
              {state.at + 1} of {cards.length}
            </span>
            <CycleButton label="Show me another" onClick={() => dispatch({ type: 'step', by: 1 })}>
              <ChevronRight className="size-4" strokeWidth={1.8} />
            </CycleButton>
          </div>
        )}
      </div>
      {state.done.map((e) => (
        <div key={e.item.id} className="fw-card fw-done">
          <FeedRowView
            entry={e}
            where={where(e)}
            {...noop}
            onOpenSent={(result) => {
              // The message it sent, or the session it started, in its space (which ends the first run).
              if (result.link) void rpc.app.openExternal(result.link);
              else if (result.session && openSession)
                openSession(result.session.root, result.session.sessionId);
            }}
          />
        </div>
      ))}
      {front && choice && (
        <>
          <span className="flex items-center gap-2 px-1 font-mono text-[11px] tracking-[0.1em] text-text-secondary uppercase" data-testid="first-win-group">
            <span
              aria-hidden
              className="hf-group-dot"
              data-tone={front.item.group === 'needs_you' ? 'warn' : 'accent'}
            />
            {front.item.group === 'needs_you' ? 'Needs you' : 'Claude can take'}
          </span>
          <div className="fw-stack grid">
            {behind > 1 && <div className="fw-peek fw-peek-2" />}
            {behind > 0 && <div className="fw-peek fw-peek-1" />}
            <div key={front.item.id} className={cn('fw-card fw-front', front.fresh && 'fw-enter')}>
              <FeedRowView
                entry={front}
                where={where(front)}
                onRun={run}
                onPick={(choiceId, slide) => dispatch({ type: 'pick', choiceId, slide })}
                onEdit={(text) => dispatch({ type: 'edit', text })}
                onEditDraft={(text) => dispatch({ type: 'edit-draft', text })}
                onReset={() => dispatch({ type: 'reset' })}
                menu={cards.length > 1 ? MENU : MENU.filter((m) => m.key !== 'another')}
                onMenu={(key) => {
                  if (key === 'another') dispatch({ type: 'step', by: 1 });
                  else if (key === 'later' || key === 'ignore') {
                    env.current.answer(front.item, key === 'later' ? 'snooze' : 'ignore');
                    dispatch({ type: 'drop' });
                  }
                }}
              />
            </div>
          </div>
        </>
      )}
      <p className="m-0 px-1 pt-2 text-[12.5px] leading-snug text-text-muted" data-testid="first-win-lead">
        {lead}
      </p>
    </div>
  );
}

function CycleButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-full text-text-secondary transition-colors hover:bg-bg-2 hover:text-text-primary"
    >
      {children}
    </button>
  );
}

/** A done card's row takes no input. */
const noop = {
  onRun: () => {},
  onPick: () => {},
  onEdit: () => {},
  onEditDraft: () => {},
  onReset: () => {},
  menu: [] as MenuItem[],
  onMenu: () => {},
};
