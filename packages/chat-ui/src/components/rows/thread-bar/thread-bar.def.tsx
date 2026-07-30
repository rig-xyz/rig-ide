/**
 * thread-bar — Slack-style persistent thread indicator emitted as a SECOND
 * unit (key: 'thread' → id `${itemId}#thread`) after a threaded message's
 * 'self' unit by the message segmenter.
 *
 * This is a Lane-A unit: it is the height-affecting representation of thread
 * presence. measure() returns a constant (vars.rowH); margin { top: 0,
 * bottom: 8 } preserves the seam to the next turn (message margin is 8/8).
 *
 * Click → commands.onReplyInThread with the ANCHOR item id (the message id),
 * the bar's own rect, and an excerpt derived from the message text.
 */

import { useCommands } from '@components/contexts/CommandsContext';
import { IconThread } from '@components/primitives/icons';
import { deriveExcerpt } from '@components/primitives/thread-excerpt';
import { defineUnit } from '@core/units';
import { formatRelativeTime } from '@lib/format';
import type { ChatMessage, ThreadSummary } from '@/model';
import { bar, barCount, barIcon, barTime, barView } from './thread-bar.css';

export type ThreadBarData = {
  /** The anchor message (segment payload of the 'self' unit). */
  message: ChatMessage;
  summary: ThreadSummary;
};

const THREAD_BAR_H = 26;

export const threadBarUnitDef = defineUnit<ThreadBarData, { rowH: number }>({
  kind: 'thread-bar',
  margin: { top: 0, bottom: 8 },
  vars: { rowH: THREAD_BAR_H },

  estimate(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    const commands = useCommands();
    let barEl: HTMLButtonElement | undefined;

    const open = () => {
      const onReplyInThread = commands().onReplyInThread;
      if (!onReplyInThread || !barEl) return;
      const r = barEl.getBoundingClientRect();
      onReplyInThread({
        itemId: props.data.message.id,
        anchorRect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
        excerpt: deriveExcerpt(props.data.message.text),
      });
    };

    const count = () => props.data.summary.count;
    const replies = () => `${count()} ${count() === 1 ? 'reply' : 'replies'}`;

    return (
      <button
        type="button"
        ref={(e) => {
          barEl = e;
        }}
        class={bar}
        style={{ height: `${props.vars.rowH}px` }}
        aria-label={`View thread — ${replies()}`}
        onClick={open}
      >
        <span class={barIcon}>
          <IconThread />
        </span>
        <span class={barCount}>{replies()}</span>
        <span class={barTime}>· last {formatRelativeTime(props.data.summary.lastAt)}</span>
        <span class={barView}>View thread ›</span>
      </button>
    );
  },
});
