/**
 * ActionPill — the single hover affordance for transcript rows (Slack-style
 * hover toolbar). Fades in at the top-right of a hovered assistant message
 * (marker: messageGroup) or tool-like UnitRow (marker: threadRowGroup).
 *
 * Contents, left to right:
 *   quick reactions (👍 🔥 ❤️) → commands.onReact({ itemId, emoji })
 *   divider
 *   quote                      → commands.onQuote({ itemId, excerpt })
 *   reply in thread            → commands.onReplyInThread({ itemId, anchorRect, excerpt })
 *
 * All state flows through the CommandsContext accessor (Lane B — the app
 * refreshes by pushing a fresh commands object). Absolutely positioned:
 * zero height impact; reveal is pure CSS (see action-pill.css.ts).
 */

import { useCommands } from '@components/contexts/CommandsContext';
import { For, Show, createMemo } from 'solid-js';
import { IconQuote, IconThread } from './icons';
import { deriveExcerpt } from './thread-excerpt';
import { actionPillInMessage, actionPillInRow, pillButton, pillDivider } from './action-pill.css';

export const QUICK_REACTIONS = ['👍', '🔥', '❤️'] as const;

export type ActionPillProps = {
  itemId: string;
  /** Plain-ish source text of the item; the excerpt is derived on click. */
  text: () => string;
  /** Which hover marker reveals the pill. */
  marker: 'message' | 'row';
};

export function ActionPill(props: ActionPillProps) {
  const commands = useCommands();
  const threadInfo = createMemo(() => commands().getThreadInfo?.(props.itemId) ?? null);

  const hasAny = () => {
    const c = commands();
    return c.onReact !== undefined || c.onQuote !== undefined || c.onReplyInThread !== undefined;
  };
  const hasActions = () => {
    const c = commands();
    return c.onQuote !== undefined || c.onReplyInThread !== undefined;
  };

  let threadBtnEl: HTMLButtonElement | undefined;

  const openThread = () => {
    const onReplyInThread = commands().onReplyInThread;
    if (!onReplyInThread || !threadBtnEl) return;
    const r = threadBtnEl.getBoundingClientRect();
    onReplyInThread({
      itemId: props.itemId,
      anchorRect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
      excerpt: deriveExcerpt(props.text()),
    });
  };

  const threadAriaLabel = () => {
    const i = threadInfo();
    if (!i) return 'Reply in thread';
    return `Thread — ${i.count} ${i.count === 1 ? 'reply' : 'replies'}${i.sent ? ', sent' : ''}`;
  };

  return (
    <Show when={hasAny()}>
      <div class={props.marker === 'message' ? actionPillInMessage : actionPillInRow}>
        <Show when={commands().onReact !== undefined}>
          <For each={QUICK_REACTIONS}>
            {(emoji) => (
              <button
                type="button"
                class={pillButton}
                aria-label={`React with ${emoji}`}
                onClick={() => commands().onReact?.({ itemId: props.itemId, emoji })}
              >
                {emoji}
              </button>
            )}
          </For>
          <Show when={hasActions()}>
            <div class={pillDivider} />
          </Show>
        </Show>
        <Show when={commands().onQuote !== undefined}>
          <button
            type="button"
            class={pillButton}
            aria-label="Quote"
            onClick={() =>
              commands().onQuote?.({
                itemId: props.itemId,
                excerpt: deriveExcerpt(props.text()),
              })
            }
          >
            <IconQuote />
          </button>
        </Show>
        <Show when={commands().onReplyInThread !== undefined}>
          <button
            type="button"
            ref={(e) => {
              threadBtnEl = e;
            }}
            class={pillButton}
            aria-label={threadAriaLabel()}
            onClick={openThread}
          >
            <IconThread />
            <Show when={threadInfo()}>
              {(i) => <span>{i().sent ? `${i().count} ✓` : i().count}</span>}
            </Show>
          </button>
        </Show>
      </div>
    </Show>
  );
}
