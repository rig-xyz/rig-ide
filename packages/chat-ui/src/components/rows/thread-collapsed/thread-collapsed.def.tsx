/**
 * thread-collapsed — a synthetic ChatItem (kind: 'thread-collapsed') the APP
 * injects into seeded turns to mark a place where a side conversation
 * happened. Renders as a single muted line ("🧵 discussed in thread"); click
 * fires commands.onReplyInThread with the ANCHOR item id (data.anchorItemId).
 *
 * Registered like any item kind (segmenter in SEGMENTERS, def in
 * UNIT_REGISTRY). Fixed height — Lane A via its own measure() only.
 */

import { useCommands } from '@components/contexts/CommandsContext';
import { IconThread } from '@components/primitives/icons';
import { deriveExcerpt } from '@components/primitives/thread-excerpt';
import { defineUnit } from '@core/units';
import type { ThreadCollapsedItem } from '@/model';
import { line, lineIcon, lineView } from './thread-collapsed.css';

const THREAD_COLLAPSED_H = 24;

export const threadCollapsedUnitDef = defineUnit<ThreadCollapsedItem, { rowH: number }>({
  kind: 'thread-collapsed',
  margin: { top: 4, bottom: 8 },
  vars: { rowH: THREAD_COLLAPSED_H },

  estimate(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    const commands = useCommands();
    let lineEl: HTMLButtonElement | undefined;

    const open = () => {
      const onReplyInThread = commands().onReplyInThread;
      if (!onReplyInThread || !lineEl) return;
      const r = lineEl.getBoundingClientRect();
      onReplyInThread({
        itemId: props.data.anchorItemId,
        anchorRect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
        excerpt: deriveExcerpt(props.data.label),
      });
    };

    return (
      <button
        type="button"
        ref={(e) => {
          lineEl = e;
        }}
        class={line}
        style={{ height: `${props.vars.rowH}px` }}
        aria-label={`View thread — ${props.data.label}`}
        onClick={open}
      >
        <span class={lineIcon}>
          <IconThread />
        </span>
        <span>{props.data.label}</span>
        <span class={lineView}>View thread ›</span>
      </button>
    );
  },
});
