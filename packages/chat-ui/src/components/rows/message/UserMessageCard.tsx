import { useCommands } from '@components/contexts/CommandsContext';
import { useTurnState } from '@components/contexts/TurnStateContext';
import { BlockStackView } from '@components/primitives/BlockStackView';
import { clipTrackedHeight, isCardAnimating } from '@components/primitives/card-clip';
import { IconCheck, IconCopy, IconStop, ImageOffIcon } from '@components/primitives/icons';
import { createClipboard } from '@components/primitives/use-clipboard';
import type { StackLayout } from '@core/compose';
import type { Measured, RenderCtx } from '@core/define';
import { layoutBlockStack } from '@core/layout/block-stack';
import { blockPlainText } from '@core/markdown/plain-text';
import { formatClockTime } from '@lib/format';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { For, Show, createMemo, createResource } from 'solid-js';
import type { ChatImageAttachment, ChatMessage } from '@/model';
import {
  attachStripHeight,
  type MessageVars,
  userCardWidth,
  userInnerWidth,
  userTimestampFooterH,
} from './metrics';
import { srOnly } from './message.css';
import {
  attachmentStrip,
  attachPlaceholder,
  attachThumb,
  attachThumbBtn,
  card,
  cardFadeOverlay,
  cardRoot,
  cardVars,
  showLessLabel,
  showMoreLabel,
  stopButtonOverlay,
  userActionsCopyButton,
  userActionsHoverGroup,
  userActionsRow,
  userActionsTimestamp,
  userCardGroup,
} from './user-message.css';

export function UserMessageCard(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  const commands = useCommands();
  const turn = useTurnState();
  const mCtx = () => props.ctx.measureCtx?.();

  const isCurrent = () => turn.currentMessageId() === props.data.id;
  const showStop = () => isCurrent() && turn.turnStatus() === 'generating';

  const styleVars = () => ({
    userCardPadX: props.vars.userCardPadX,
    userCardPadY: props.vars.userCardPadY,
    cardBorder: props.vars.cardBorder,
    attachThumb: props.vars.attachThumb,
    attachGap: props.vars.attachGap,
  });

  // The card's own rendered width — content-fit, hugging short messages
  // instead of always filling the ratio-capped column (see `userCardWidth`'s
  // doc comment; design-system reference: Claude Code / Codex). `innerWidth`
  // is derived from the SAME call so text is always measured at the width
  // it's actually drawn at; a plain CSS max-width here without also
  // narrowing the measured wrap width would make the engine's reserved
  // height wrong.
  const cardWidth = () => {
    const c = mCtx();
    return c ? userCardWidth(props.data.text, c, props.vars) : 0;
  };

  const innerWidth = () => {
    const c = mCtx();
    return c ? userInnerWidth(props.data.text, c, props.vars) : 0;
  };

  const stack = createMemo<Measured<StackLayout> | null>(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    const blocks = ctx.caches.parseBlocks(props.data.id, props.data.text);
    if (blocks.length === 0) return null;
    const innerCtx = { ...ctx, width: innerWidth() };
    return layoutBlockStack(blocks, innerCtx, { isCollapsed: ctx.isCollapsed });
  });

  const fullContentH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return props.vars.collapsedMaxH;
    const innerW = userInnerWidth(props.data.text, ctx, props.vars);
    const aH = attachStripHeight(props.data.attachments?.length ?? 0, innerW, props.vars);
    const blocks = ctx.caches.parseBlocks(props.data.id, props.data.text);
    if (blocks.length === 0) {
      return (
        aH +
        ctx.theme.fonts.body.lineHeight +
        2 * props.vars.userCardPadY +
        2 * props.vars.cardBorder
      );
    }
    const innerCtx = { ...ctx, width: innerW };
    const s = layoutBlockStack(blocks, innerCtx, { isCollapsed: ctx.isCollapsed });
    return aH + s.height + 2 * props.vars.userCardPadY + 2 * props.vars.cardBorder;
  });

  const isExpanded = () => mCtx()?.expandedId === props.data.id;
  const maxH = () => (isExpanded() ? props.vars.expandedMaxH : props.vars.collapsedMaxH);
  const clampedH = () => Math.min(fullContentH(), maxH());
  const isOverflowing = () => fullContentH() > maxH();
  // Round (long user message clamp): `isOverflowing()` is checked against
  // whichever cap is CURRENTLY active, so once expanded it's almost always
  // false (against the generous `expandedMaxH`) — useless for deciding
  // whether "Show less" should appear. This checks against the COLLAPSED
  // cap specifically, regardless of current expand state, so the "Show
  // less" affordance only shows for a message that was actually clamped
  // in the first place.
  const wasOverflowingCollapsed = () => fullContentH() > props.vars.collapsedMaxH;

  // Track the animated clip edge during expand/collapse tween so the bottom
  // border and rounded corners are never hidden by the UnitRow overflow clip.
  const cardH = clipTrackedHeight(props.ctx, clampedH);

  const plainText = () => {
    const ctx = mCtx();
    if (!ctx) return props.data.text;
    return ctx.caches.parseBlocks(props.data.id, props.data.text).map(blockPlainText).join('\n\n');
  };

  // The actions-row footer is NOT part of the collapse/expand tween (it's a
  // fixed row, not animated content) — added on top of the tweened card
  // height. 0 when `at` is unset AND the message never needed a clamp
  // affordance, so a host that uses neither feature renders byte-for-byte
  // what it always has — same gate the copy button rides along on (Round E
  // replaces the bare timestamp row with copy + timestamp together, not a
  // separate row). Clamp-redesign round: `wasOverflowingCollapsed()` also
  // opens this gate now that "Show more"/"Show less" render in this row
  // instead of inside the card (see `userTimestampFooterH`'s own comment).
  const footerH = () => userTimestampFooterH(props.data, props.vars, wasOverflowingCollapsed());
  const clock = () => (typeof props.data.at === 'number' ? formatClockTime(props.data.at) : '');
  const clipboard = createClipboard();

  return (
    <div
      class={userCardGroup}
      style={{
        // Capped, right-aligned bubble rather than a full-width slab: the row
        // still reserves the full column (chrome.insetX=0, unchanged — see
        // unit-registry.ts); the wrapper itself doesn't fill it. Both the
        // card and the timestamp row below it inherit this same width, so
        // the timestamp's right edge always lines up with the bubble's.
        width: `${cardWidth()}px`,
        'margin-left': 'auto',
        height: `${cardH() + footerH()}px`,
      }}
    >
      <div
        data-user-card={props.data.id}
        class={`${card({ state: isOverflowing() && !isExpanded() ? 'overflowing' : 'static', current: showStop() })} ${cardRoot}`}
        style={{
          ...assignInlineVars(cardVars, pxTokens({ ...styleVars(), height: cardH() })),
          width: '100%',
          // Force overflow:hidden while the UnitRow tween is in flight to avoid
          // a transient scrollbar mid-animation; restore auto only when expanded
          // at rest (so the user can scroll long messages).
          'overflow-y': isCardAnimating(props.ctx) || !isExpanded() ? 'hidden' : 'auto',
          // Round (long user message clamp): the pointer cursor now also
          // shows once expanded (the card is clickable-to-collapse too,
          // since `ChatRoot.tsx`'s click handler became a real toggle) —
          // but only for a message that was genuinely clamped in the
          // first place, never a short one that happens to be "expanded"
          // trivially.
          cursor: isOverflowing() || (isExpanded() && wasOverflowingCollapsed()) ? 'pointer' : 'default',
        }}
      >
        <div class={srOnly}>{plainText()}</div>
        <Show when={props.data.attachments?.length}>
          <div class={attachmentStrip}>
            <For each={props.data.attachments}>
              {(att) => <AttachmentThumb attachment={att} itemId={props.data.id} />}
            </For>
          </div>
        </Show>
        <Show when={stack()}>{(s) => <BlockStackView node={s()} />}</Show>
        {/* Clamp-redesign round (Dylan's screenshot): the fade alone is the
            truncation cue now — "Show more" used to render right on top of
            it here and got moved out to the below-bubble actions row (see
            `showMoreLabel` there). Nothing renders over the fade anymore. */}
        <Show when={!isExpanded() && isOverflowing()}>
          <div class={cardFadeOverlay} />
        </Show>
        <Show when={showStop()}>
          <button
            type="button"
            class={stopButtonOverlay}
            aria-label="Stop generating"
            onClick={(e) => {
              e.stopPropagation();
              commands().onStop?.({ itemId: props.data.id });
            }}
          >
            <IconStop />
          </button>
        </Show>
      </div>
      <Show when={footerH() > 0}>
        <div
          class={userActionsRow}
          style={{ height: `${footerH()}px`, 'line-height': `${props.vars.userTimestampH}px` }}
        >
          {/* Copy + timestamp (+ "Show less", once expanded) — hover-only,
              exactly as this row always was; only `showMoreLabel` below
              breaks out of that gate. */}
          <div class={userActionsHoverGroup}>
            <button
              type="button"
              class={userActionsCopyButton}
              aria-label={clipboard.copied() ? 'Copy message — copied' : 'Copy message'}
              onClick={() => clipboard.copy(plainText())}
            >
              <Show when={clipboard.copied()} fallback={<IconCopy />}>
                <IconCheck />
              </Show>
            </button>
            <span class={userActionsTimestamp}>{clock()}</span>
            <Show when={isExpanded() && wasOverflowingCollapsed()}>
              <span class={showLessLabel} data-user-card={props.data.id}>
                Show less
              </span>
            </Show>
          </div>
          {/* Clamp-redesign round: persistent — sibling of the hover group
              above, not a child of it, so it stays visible regardless of
              hover (a hidden expander on clamped content is dishonest).
              `data-user-card` lets `ChatRoot.tsx`'s click delegation find
              this exact message even though it's outside the card's own
              DOM subtree now — no separate click handler. */}
          <Show when={isOverflowing() && !isExpanded()}>
            <span class={showMoreLabel} data-user-card={props.data.id}>
              Show more
            </span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function AttachmentThumb(props: { attachment: ChatImageAttachment; itemId: string }) {
  const commands = useCommands();
  const [resolvedDataUrl] = createResource(
    () => (props.attachment.dataUrl ? null : props.attachment.id),
    async () => commands().resolveAttachment?.(props.attachment) ?? null
  );
  const dataUrl = () => props.attachment.dataUrl ?? resolvedDataUrl() ?? undefined;

  return (
    <Show
      when={dataUrl()}
      fallback={
        <div title={props.attachment.name} class={attachPlaceholder}>
          <ImageOffIcon />
        </div>
      }
    >
      {(src) => (
        <button
          type="button"
          class={attachThumbBtn}
          aria-label={`View image: ${props.attachment.name}`}
          onClick={(e) => {
            e.stopPropagation();
            commands().onViewImage?.({
              attachment: { ...props.attachment, dataUrl: src() },
              itemId: props.itemId,
              source: 'user-message',
            });
          }}
        >
          <img src={src()} alt={props.attachment.name} class={attachThumb} />
        </button>
      )}
    </Show>
  );
}

export { userInnerWidth };
export type { MessageVars };
