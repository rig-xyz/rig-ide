import { ArrowRight } from 'lucide-react';
import { useEffect, useReducer, useRef } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { sourceName } from '@renderer/features/home-feed/bits';
import { FeedRowView, type MenuItem } from '@renderer/features/home-feed/feed-row';
import { chosen } from '@renderer/features/home-feed/say';
import type { FeedEntry } from '@renderer/features/home-feed/store';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { StepFrame, type StepProps } from '../first-run';
import { firstWinReducer, initialFirstWin } from './first-win-model';
import './first-win.css';

/**
 * Onboarding's First win (spec Step 6): the first card Rig found, as a real
 * Feed row with its answer drafted in the person's words, the other answers
 * a carousel away, and the next ready cards peeking behind. One click sends
 * it; then the next card comes forward, and Open my Home ends the first run.
 */

const MENU: MenuItem[] = [
  { key: 'another', label: 'Show me another', hint: 'Something else I found for you' },
  { key: 'later', label: 'Not now', hint: 'Hide it until tomorrow' },
  { key: 'ignore', label: 'Ignore', hint: 'Hide it; Rig learns from it' },
];

const where = (e: FeedEntry) => (e.item.source ? sourceName(e.item.source.connector) : 'Rig');

export function FirstWinStep({ env, position, onNext, setFieldLook }: StepProps) {
  const [state, dispatch] = useReducer(firstWinReducer, initialFirstWin);
  const firstWin = useRef(env.firstWin);
  useEffect(() => setFieldLook('dim'), [setFieldLook]);
  useEffect(() => {
    let live = true;
    void firstWin.current.cards().then((items) => live && dispatch({ type: 'loaded', items: items ?? [] }));
    return () => {
      live = false;
    };
  }, []);

  const queue = state.queue;
  const front = queue?.[0];
  const rest = queue?.slice(1) ?? [];
  const sentOnce = state.done.length > 0;
  const choice = front ? chosen(front.item, front.pick) : null;

  const run = () => {
    if (!front || !choice || front.starting) return;
    dispatch({ type: 'starting' });
    const go =
      choice.verb === 'send' || choice.verb === 'post'
        ? firstWin.current.send(front.item, choice, front.draftEdit ?? choice.draft?.text ?? '')
        : firstWin.current.start(front.item, choice);
    void go.then((r) => dispatch(r.success ? { type: 'sent', result: r.data } : { type: 'failed', error: r.error }));
  };

  const heading = !queue
    ? 'Getting your first one…'
    : !front
      ? sentOnce
        ? 'Done. One click.'
        : 'Nothing needs you right now.'
      : sentOnce
        ? 'Done. One click.'
        : state.front === 'another'
          ? 'Here’s another one.'
          : 'Your first one is ready.';
  const lead = !queue
    ? 'Reading your Feed.'
    : !front
      ? sentOnce
        ? 'That’s everything for now. Your Home is ready.'
        : 'Rig keeps an eye out from here, and your Feed fills as things come in.'
      : sentOnce
        ? 'I’ll keep going in the background. Here’s what’s next.'
        : choice?.draft
          ? front.item.choices.length > 1
            ? 'Send it, or use the arrows to see the other answers I drafted. ▾ has more.'
            : 'Send it as it is, or change the words first. ▾ has more.'
          : 'Start it and Claude does the work in a session; the result comes back here.';

  return (
    <StepFrame
      guide={
        <>
          <span className="font-mono text-[11px] tracking-[0.09em] text-text-muted uppercase">
            {position ? `${position} · ` : ''}Your first one
          </span>
          <h2 className="m-0 font-display text-[25px] leading-[1.18] font-semibold tracking-[-0.015em] text-balance text-text-primary">
            {heading}
          </h2>
          <p className="m-0 text-[14.5px] leading-[1.55] text-text-secondary">{lead}</p>
          <div className="flex-1" />
          <div className="flex flex-wrap items-center gap-2.5">
            <ActionButton variant={sentOnce || (queue && !front) ? 'primary' : 'quiet'} icon={ArrowRight} onClick={onNext}>
              Open my Home
            </ActionButton>
            {sentOnce && <span className="text-[12.5px] text-text-muted">The rest is waiting there</span>}
          </div>
        </>
      }
      stage={
        <div className="fw-panel flex w-[min(450px,100%)] flex-col gap-2.5" data-testid="first-win">
          <span className="fw-tab self-start rounded-full px-[13px] py-1.5 text-[13.5px] font-semibold text-text-primary">Feed</span>
          {state.done.map((e) => (
            <div key={e.item.id} className="fw-card fw-done">
              <FeedRowView entry={e} where={where(e)} {...noop} onOpenSent={(link) => void rpc.app.openExternal(link)} />
            </div>
          ))}
          {front && choice && (
            <>
              <span className="fw-section font-mono text-[11px] tracking-[0.1em] text-text-secondary uppercase" data-needs={front.item.group === 'needs_you'}>
                {front.item.group === 'needs_you' ? 'Needs you' : 'Claude can take'}
              </span>
              <div className="fw-stack grid">
                {rest.length > 1 && <div className="fw-peek fw-peek-2" />}
                {rest.length > 0 && <div className="fw-peek fw-peek-1" />}
                <div key={front.item.id} className={cn('fw-card fw-front', front.fresh && 'fw-enter')}>
                  <FeedRowView
                    entry={front}
                    where={where(front)}
                    onRun={run}
                    onPick={(choiceId, slide) => dispatch({ type: 'pick', choiceId, slide })}
                    onEdit={(text) => dispatch({ type: 'edit', text })}
                    onEditDraft={(text) => dispatch({ type: 'edit-draft', text })}
                    onReset={() => dispatch({ type: 'reset' })}
                    menu={rest.length ? MENU : MENU.filter((m) => m.key !== 'another')}
                    onMenu={(key) => {
                      if (key === 'another') dispatch({ type: 'another' });
                      else if (key === 'later' || key === 'ignore') {
                        firstWin.current.answer(front.item, key === 'later' ? 'snooze' : 'ignore');
                        dispatch({ type: 'drop' });
                      }
                    }}
                  />
                </div>
              </div>
              {rest.length > 0 && (
                <p className="m-0 flex flex-wrap items-center gap-2 px-1 pt-3.5 text-[12.5px] text-text-muted" data-testid="first-win-more">
                  <span>{rest.length} more ready</span>
                  <b className="font-medium text-text-secondary">
                    {rest
                      .slice(0, 2)
                      .map((e) => e.item.title)
                      .join(' · ')}
                  </b>
                </p>
              )}
            </>
          )}
        </div>
      }
    />
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
