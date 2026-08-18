import { measureProseNaturalWidth } from '@components/rows/markdown/prose/layout';
import type { MeasureCtx } from '@core/define';

export type MessageVars = {
  cardBorder: number;
  collapsedMaxH: number;
  expandedMaxH: number;
  userCardPadX: number;
  userCardPadY: number;
  attachThumb: number;
  attachGap: number;
  footerH: number;
  /** Absolute cap (px) on the user bubble's width, for wide panels. */
  maxCardWidth: number;
  /** Gap (px) between the user card and its below-bubble timestamp row. */
  userTimestampGap: number;
  /** Height (px) of the below-bubble timestamp row. */
  userTimestampH: number;
};

/** Subset of MessageVars projected into CSS via the VE contract. */
export type MessageStyleVars = {
  userCardPadX: number;
  userCardPadY: number;
  cardBorder: number;
  attachThumb: number;
  attachGap: number;
};

/**
 * Fraction of the available row width a user bubble may fill. Applied before
 * `maxCardWidth` so the bubble reads as a bubble (not a full-width slab) even
 * in a narrow panel, where the absolute cap alone would rarely bind. This is
 * now the CEILING a bubble grows toward for long content, not its default —
 * see `userCardWidth` below (Round E: reference-grade bubbles hug short
 * messages instead of always filling this ratio).
 */
const USER_CARD_WIDTH_RATIO = 0.82;

/** Content-fit floor — enough for a short word/emoji + padding, never a sliver. */
const MIN_USER_CARD_WIDTH = 56;

/**
 * The user card's own width — content-fit, the same way Claude Code's and
 * Codex's own bubbles hug short messages rather than always filling the
 * ratio-capped column. Measures the longest line of `text` as plain prose
 * (not fully markdown-block-aware — bold/code spans can shift a font's
 * natural width slightly) and sizes the bubble to it, clamped between
 * `MIN_USER_CARD_WIDTH` and the same ratio/absolute ceiling this always
 * enforced, so long messages still wrap exactly as before. A deliberate v1
 * approximation: user messages are overwhelmingly short plain text, and a
 * fully block-aware measurement would need to branch per block kind (code,
 * table, list...) for a case that's rare in practice here.
 *
 * The single choke point both the card's rendered width (`UserMessageCard`)
 * and its measured inner width (below) go through, so wrapping is always
 * measured at the width it's actually drawn at.
 */
export function userCardWidth(text: string, ctx: MeasureCtx, vars: MessageVars): number {
  const ceiling = Math.max(1, Math.min(ctx.width * USER_CARD_WIDTH_RATIO, vars.maxCardWidth));
  const longestLine = text
    .split('\n')
    .reduce((longest, line) => (line.length > longest.length ? line : longest), '');
  const natural = measureProseNaturalWidth(
    {
      kind: 'prose',
      id: 'user-card-content-width',
      variant: 'body',
      runs: [{ kind: 'text', text: longestLine || ' ' }],
    },
    ctx.theme.fonts
  );
  const contentWidth = natural + 2 * vars.userCardPadX + 2 * vars.cardBorder;
  return Math.max(MIN_USER_CARD_WIDTH, Math.min(contentWidth, ceiling));
}

/** Available width for block layout inside the user card. */
export function userInnerWidth(text: string, ctx: MeasureCtx, vars: MessageVars): number {
  return Math.max(1, userCardWidth(text, ctx, vars) - 2 * vars.userCardPadX - 2 * vars.cardBorder);
}

/**
 * Total height consumed by the attachment strip (including the bottom gap that
 * separates it from the text block). Returns 0 when there are no attachments.
 */
export function attachStripHeight(count: number, innerW: number, vars: MessageVars): number {
  if (count <= 0) return 0;
  const { attachThumb: thumb, attachGap: gap } = vars;
  const perRow = Math.max(1, Math.floor((innerW + gap) / (thumb + gap)));
  const rows = Math.ceil(count / perRow);
  return rows * thumb + (rows - 1) * gap + gap;
}

/**
 * The below-bubble actions row's height — 0 when the host never set `at`
 * (e.g. a host with no persistence at all) AND the message never needed a
 * clamp affordance, so nothing shifts for a consumer that uses neither
 * feature. See `ChatMessage.at`'s doc comment.
 *
 * Clamp-redesign round: `needsClampAffordance` (was this message's FULL
 * content taller than `collapsedMaxH`, regardless of current expand state —
 * `UserMessageCard.tsx`'s own `wasOverflowingCollapsed`) also reserves the
 * row now that "Show more"/"Show less" render there instead of inside the
 * card. Without this, a host that never sets `at` would lose the affordance
 * entirely for a genuinely long message — the row it now lives in wouldn't
 * exist. Defaults to `false` so the pre-existing `at`-only behavior is
 * unchanged for every call site that doesn't pass it.
 *
 * Shared by `message.def.tsx` (measure) and `UserMessageCard.tsx` (render) —
 * kept here rather than either of those to avoid a circular import between them.
 */
export function userTimestampFooterH(
  item: { at?: number | null },
  vars: MessageVars,
  needsClampAffordance = false
): number {
  return typeof item.at === 'number' || needsClampAffordance
    ? vars.userTimestampGap + vars.userTimestampH
    : 0;
}
