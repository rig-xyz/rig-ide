/**
 * ReactionChips — app-stored reactions rendered as small "👍 2" pills.
 * ThreadBadge — persistent 🧵N chip for threaded tool-like rows.
 *
 * Both read state via the CommandsContext accessor in a createMemo (Lane B):
 * the app refreshes by pushing a fresh commands object. Neither affects
 * measured height — chips live inside the assistant footer's reserved 24px
 * row or a tool-row absolute overlay.
 */

import { useCommands } from '@components/contexts/CommandsContext';
import { For, Show, createMemo } from 'solid-js';
import { deriveExcerpt } from './thread-excerpt';
import { chip, chipMine, chipRow, threadBadge } from './reaction-chips.css';

export type ReactionChipsProps = {
  itemId: string;
};

export function ReactionChips(props: ReactionChipsProps) {
  const commands = useCommands();
  const reactions = createMemo(() => commands().getReactions?.(props.itemId) ?? null);

  return (
    <Show when={reactions() && reactions()!.length > 0}>
      <div class={chipRow}>
        <For each={reactions()!}>
          {(r) => (
            <button
              type="button"
              class={r.mine ? `${chip} ${chipMine}` : chip}
              aria-label={`${r.emoji} ${r.count} ${r.count === 1 ? 'reaction' : 'reactions'}${r.mine ? ', including yours' : ''}`}
              aria-pressed={r.mine}
              onClick={() => commands().onReact?.({ itemId: props.itemId, emoji: r.emoji })}
            >
              <span>{r.emoji}</span>
              <span>{r.count}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

export type ThreadBadgeProps = {
  itemId: string;
  /** Plain-ish source text of the item; the excerpt is derived on click. */
  text: () => string;
};

export function ThreadBadge(props: ThreadBadgeProps) {
  const commands = useCommands();
  const info = createMemo(() => commands().getThreadInfo?.(props.itemId) ?? null);

  let btnEl: HTMLButtonElement | undefined;

  const open = () => {
    const onReplyInThread = commands().onReplyInThread;
    if (!onReplyInThread || !btnEl) return;
    const r = btnEl.getBoundingClientRect();
    onReplyInThread({
      itemId: props.itemId,
      anchorRect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
      excerpt: deriveExcerpt(props.text()),
    });
  };

  return (
    <Show when={info()}>
      {(i) => (
        <button
          type="button"
          ref={(e) => {
            btnEl = e;
          }}
          class={threadBadge}
          aria-label={`Thread — ${i().count} ${i().count === 1 ? 'reply' : 'replies'}`}
          onClick={open}
        >
          <span aria-hidden="true">🧵</span>
          <span>{i().count}</span>
        </button>
      )}
    </Show>
  );
}
