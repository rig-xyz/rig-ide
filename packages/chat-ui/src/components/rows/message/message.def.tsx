import { StreamContext, type StreamAnimation } from '@components/contexts/StreamContext';
import { ActionPill } from '@components/primitives/ActionPill';
import { BlockStackView } from '@components/primitives/BlockStackView';
import { CopyButton } from '@components/primitives/CopyButton';
import { ReactionChips } from '@components/primitives/ReactionChips';
import type { StackLayout } from '@core/compose';
import type { MeasureCtx, Measured, RenderCtx } from '@core/define';
import { layoutBlockStack } from '@core/layout/block-stack';
import type { Block } from '@core/markdown/document';
import { blockPlainText } from '@core/markdown/plain-text';
import type { SegmentCtx } from '@core/units';
import { defineUnit } from '@core/units';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo } from 'solid-js';
import type { ChatMessage } from '@/model';
import { attachStripHeight, type MessageVars, userInnerWidth, userTimestampFooterH } from './metrics';
import { UserMessageCard } from './UserMessageCard';
import {
  assistantOuter,
  assistantRoot,
  assistantVars,
  footerRow,
  messageText,
  srOnly,
} from './message.css';

export function messageFromItem(item: ChatMessage, ctx: SegmentCtx): ChatMessage {
  return {
    ...item,
    streaming: ctx.active && item.role === 'assistant',
    attachments: item.attachments?.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
    })),
  };
}

// ── Measure ───────────────────────────────────────────────────────────────────

type UserCardHeights = {
  /** Uncapped content height — what the card would need to show everything. */
  fullH: number;
  /** `fullH`, capped to whichever bound (collapsed/expanded) is currently active. */
  cardH: number;
};

/**
 * One measure pass for the user card, shared by `measureUserCard` (below —
 * the card's own height, before the below-bubble actions row) and
 * `measureMessage` (which also needs `fullH` to know whether the row must
 * reserve space for "Show more" even when `at` is unset — see
 * `userTimestampFooterH`'s own doc comment). Computed once so a message's
 * height is never measured (and its block stack never laid out) twice per
 * pass.
 */
function computeUserCardHeights(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): UserCardHeights {
  const { userCardPadY, cardBorder, collapsedMaxH, expandedMaxH } = vars;
  const blocks = ctx.caches.parseBlocks(item.id, item.text);
  const innerW = userInnerWidth(item.text, ctx, vars);
  const aH = attachStripHeight(item.attachments?.length ?? 0, innerW, vars);
  const cap = ctx.expandedId === item.id ? expandedMaxH : collapsedMaxH;
  let fullH: number;
  if (blocks.length === 0) {
    fullH = aH + ctx.theme.fonts.body.lineHeight + 2 * userCardPadY + 2 * cardBorder;
  } else {
    const innerCtx = { ...ctx, width: innerW };
    const stack = layoutBlockStack(blocks, innerCtx, { isCollapsed: ctx.isCollapsed });
    fullH = aH + stack.height + 2 * userCardPadY + 2 * cardBorder;
  }
  return { fullH, cardH: Math.min(fullH, cap) };
}

/**
 * A user card's own height, before the below-bubble actions row. Kept
 * separate from the row's own addition so `UserMessageCard` (which needs
 * the card height alone to size its animated tween) and `measureMessage`
 * (which needs card + row together) share the exact same number.
 */
export function measureUserCard(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): number {
  return computeUserCardHeights(item, ctx, vars).cardH;
}

export function measureMessage(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): number {
  if (item.role === 'user') {
    const { fullH, cardH } = computeUserCardHeights(item, ctx, vars);
    // Clamp-redesign round: "was this message's FULL content taller than
    // the collapsed cap" — regardless of `ctx.expandedId` (which only
    // decides `cardH`'s own current cap) — same test as
    // `UserMessageCard.tsx`'s own `wasOverflowingCollapsed`, computed here
    // for `userTimestampFooterH`'s benefit (the row it now needs to reserve
    // space in, even for an `at`-less host).
    const needsClampAffordance = fullH > vars.collapsedMaxH;
    return cardH + userTimestampFooterH(item, vars, needsClampAffordance);
  }

  // assistant / thought
  const blocks = item.streaming
    ? ctx.caches.parseBlocksStreaming(item.id, item.text)
    : ctx.caches.parseBlocks(item.id, item.text);
  const footer = item.role === 'assistant' ? vars.footerH : 0;
  if (blocks.length === 0) {
    return ctx.theme.fonts.body.lineHeight + footer;
  }
  const stack = layoutBlockStack(blocks, ctx, { isCollapsed: ctx.isCollapsed });
  return stack.height + footer;
}

function AssistantRender(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  const mCtx = () => props.ctx.measureCtx?.();

  // One frontier Map per mounted instance — persists across streaming chunks
  // because the <For> in UnitRow keeps this component alive. Shared by ref with
  // StreamContext so Prose.tsx can update it after each render without reactivity.
  //
  // `streaming` and `settledCount` are reactive accessors so Code.tsx effects
  // track the per-block settled transition (fence close or blank-line boundary)
  // and highlight each block exactly once when it crosses that boundary.
  const parsed = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return { blocks: [] as Block[], settledCount: 0 };
    const blocks = props.data.streaming
      ? ctx.caches.parseBlocksStreaming(props.data.id, props.data.text)
      : ctx.caches.parseBlocks(props.data.id, props.data.text);
    const settledCount = props.data.streaming
      ? ctx.caches.settledBlockCount(props.data.id)
      : blocks.length;
    return { blocks, settledCount };
  });

  const streamAnimation: StreamAnimation = {
    frontier: new Map(),
    streaming: () => props.data.streaming === true,
    settledCount: () => parsed().settledCount,
  };

  const stack = createMemo<Measured<StackLayout> | null>(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    const blocks = parsed().blocks;
    if (blocks.length === 0) return null;
    return layoutBlockStack(blocks, ctx, { isCollapsed: ctx.isCollapsed });
  });

  const totalH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return props.data.role === 'assistant' ? props.vars.footerH : 0;
    return measureMessage(props.data, ctx, props.vars);
  });

  const plainText = () => {
    const ctx = mCtx();
    if (!ctx) return props.data.text;
    // Use the same parse path as the renderer so we don't trigger a full reparse
    // during streaming just for the screen-reader text.
    const parse = props.data.streaming ? ctx.caches.parseBlocksStreaming : ctx.caches.parseBlocks;
    return parse(props.data.id, props.data.text).map(blockPlainText).join('\n\n');
  };

  const role = () =>
    (props.data.role === 'thought' ? 'thought' : 'assistant') as 'thought' | 'assistant';

  return (
    <div
      class={`${assistantOuter} ${messageText({ role: role() })} ${assistantRoot}`}
      style={assignInlineVars(assistantVars, pxTokens({ height: totalH() }))}
    >
      <div class={srOnly}>{plainText()}</div>
      <StreamContext.Provider value={props.data.streaming ? streamAnimation : null}>
        <Show when={stack()}>{(s) => <BlockStackView node={s()} />}</Show>
      </StreamContext.Provider>
      <Show when={props.data.role === 'assistant'}>
        <div
          class={footerRow}
          style={{ height: `${props.vars.footerH}px` }}
          aria-hidden={props.data.streaming ? 'true' : undefined}
        >
          <Show when={!props.data.streaming}>
            <CopyButton text={props.data.text} variant="inline" label="Copy message" />
            <div style={{ 'margin-left': '10px', display: 'flex' }}>
              <ReactionChips itemId={props.data.id} />
            </div>
          </Show>
        </div>
      </Show>
      <Show when={props.data.role === 'assistant' && !props.data.streaming}>
        <ActionPill itemId={props.data.id} text={() => props.data.text} marker="message" />
      </Show>
    </div>
  );
}

// ── MessageUnitRender ─────────────────────────────────────────────────────────

function MessageUnitRender(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars }) {
  if (props.data.role === 'user') {
    return <UserMessageCard data={props.data} ctx={props.ctx} vars={props.vars} />;
  }
  return <AssistantRender data={props.data} ctx={props.ctx} vars={props.vars} />;
}

// ── UnitDef ───────────────────────────────────────────────────────────────────

export const messageUnitDef = defineUnit<ChatMessage, MessageVars>({
  kind: 'message',
  margin: { top: 8, bottom: 8 },
  vars: {
    cardBorder: 1,
    // Clamp-redesign round (Dylan's screenshot + threshold ask): 120 clamped
    // at ~5 body lines (120 − 2×userCardPadY(8) − 2×cardBorder(1) = 84px of
    // text ÷ the body font's 20px line-height) — aggressive enough that
    // ordinary 4-8 line prompts routinely clamped. 280 clamps at ~13 body
    // lines instead (280 − 18 = 262px ÷ 20px ≈ 13.1), landing in the
    // requested 12-14 range: a typical prompt now renders in full, no fade,
    // no affordance — only genuinely long messages ever see "Show more".
    collapsedMaxH: 280,
    expandedMaxH: 360,
    // Calmer padding (Round E, reference: Claude Code / Codex bubbles) —
    // both values stay on the design system's 4/8/12/16/24/32 spacing
    // scale, just a step tighter than the original 16/16.
    userCardPadX: 12,
    userCardPadY: 8,
    attachThumb: 32,
    attachGap: 8,
    footerH: 24,
    maxCardWidth: 560,
    userTimestampGap: 4,
    userTimestampH: 16,
  },

  estimate(item, ctx, vars): number {
    if (item.role === 'user') {
      const innerW = userInnerWidth(item.text, ctx, vars);
      const lines = Math.max(1, Math.ceil(item.text.length / 60));
      const aH = attachStripHeight(item.attachments?.length ?? 0, innerW, vars);
      const est =
        aH + lines * ctx.theme.fonts.body.lineHeight + 2 * vars.userCardPadY + 2 * vars.cardBorder;
      const cardH = Math.min(est, ctx.expandedId === item.id ? vars.expandedMaxH : vars.collapsedMaxH);
      return cardH + userTimestampFooterH(item, vars);
    }
    const lines = Math.max(1, Math.ceil(item.text.length / 60));
    const footer = item.role === 'assistant' ? vars.footerH : 0;
    return lines * ctx.theme.fonts.body.lineHeight + footer;
  },

  measure: measureMessage,

  Render: MessageUnitRender,
});
