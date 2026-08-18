import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { MessageStyleVars } from './metrics';
import { fadeOverlayBottom, fadeOverlayTop } from '@styles/effects.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

/**
 * Dedicated group-hover marker for the stop button.
 *
 * Apply this class to the user card root so that hovering anywhere on the card
 * reveals the stop button. Keying the reveal to this dedicated empty marker
 * (rather than a structural class like cardRoot) isolates it from the
 * messageGroup/codeGroup hover reveals already present in descendant nodes,
 * preventing cross-nesting leakage — same pattern as the copy-button isolation.
 */
export const userCardGroup = style({});

// ── Runtime geometry contract ─────────────────────────────────────────────────
// Set per-instance via assignInlineVars in message.def.tsx.

export const cardVars = createVariableThemeContract<MessageStyleVars & { height: number }>({
  height: null,
  userCardPadX: null,
  userCardPadY: null,
  cardBorder: null,
  attachThumb: null,
  attachGap: null,
});

export const cardRoot = style({ height: cardVars.height });

// ── UserMessageCard ───────────────────────────────────────────────────────────

export const card = recipe({
  base: {
    position: 'relative',
    borderRadius: vars.radiusLg,
    borderStyle: 'solid',
    borderWidth: cardVars.cardBorder,
    borderColor: vars.userCardBorder,
    background: vars.userCardBg,
    color: vars.fgBody,
    paddingLeft: cardVars.userCardPadX,
    paddingRight: cardVars.userCardPadX,
    paddingTop: cardVars.userCardPadY,
    paddingBottom: cardVars.userCardPadY,
    boxSizing: 'border-box',
  },
  variants: {
    state: {
      static: {},
      overflowing: {
        selectors: {
          '&:hover': { borderColor: vars.userCardBorderHover },
        },
      },
    },
    /** When true, the hover border shows regardless of overflow state. */
    current: {
      false: {},
      true: {
        selectors: {
          '&:hover': { borderColor: vars.userCardBorderHover },
        },
      },
    },
  },
});

/**
 * Stop button — absolutely positioned top-right of the user message card.
 *
 * Isolated reveal: opacity 0 by default; revealed only when `userCardGroup`
 * is hovered (`${userCardGroup}:hover &`). The reveal selector is on this
 * style itself (not a shared base), and keyed to the dedicated `userCardGroup`
 * marker, so it cannot leak to/from the messageGroup/codeGroup hover contexts
 * in descendant code blocks or sibling assistant messages.
 */
export const stopButtonOverlay = style({
  position: 'absolute',
  top: '6px',
  right: '6px',
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '4px',
  borderRadius: vars.radiusSm,
  border: 'none',
  background: 'transparent',
  color: vars.fgMuted,
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity 150ms ease',
  selectors: {
    [`${userCardGroup}:hover &`]: { opacity: 1 },
    '&:focus-visible': { opacity: 1 },
    '&:hover': { color: vars.fg },
  },
});

/**
 * Below-bubble actions row (design-system Rule 9: "timestamps and message
 * actions live outside bubbles, below, muted") — a normal-flow sibling
 * under the card, not an overlay on top of it. Round E: replaces Round D's
 * bare timestamp-only row with copy + timestamp together.
 *
 * Clamp-redesign round (Dylan's screenshot: "Show more" rendered
 * overlapping the fading last line inside the bubble): this outer row is
 * now a PLAIN flex container with no opacity of its own — copy + timestamp
 * still fade in together on hover, but that reveal now lives one level
 * down, on `userActionsHoverGroup`, so `showMoreLabel` (a sibling here, not
 * a child of that group) can stay visible regardless of hover. A hidden
 * expander on clamped content is dishonest; the copy button and timestamp
 * staying hover-only is fine — nothing about them is load-bearing.
 */
export const userActionsRow = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '6px',
});

/**
 * Copy button + timestamp (+ "Show less", once expanded) — the same
 * isolated hover-reveal `userActionsRow` used to carry directly, keyed to
 * the wrapper's `userCardGroup` marker (moved there in `UserMessageCard` so
 * hovering the card OR this row reveals it).
 */
export const userActionsHoverGroup = style({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  opacity: 0,
  transition: 'opacity 150ms ease',
  selectors: {
    [`${userCardGroup}:hover &`]: { opacity: 1 },
  },
});

/** Icon-only copy button, sized to sit quietly beside the timestamp in `userActionsHoverGroup`. */
export const userActionsCopyButton = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2px',
  border: 'none',
  borderRadius: vars.radiusSm,
  background: 'transparent',
  color: vars.fgMuted,
  cursor: 'pointer',
  selectors: {
    '&:hover': { color: vars.fg },
    '&:focus-visible': { color: vars.fg },
  },
});

/**
 * Deliberate carve-out from the "mono for metadata" rule (Dylan): the chat
 * transcript's message-meta row is a conversational surface, not technical
 * metadata — regular sans (the app's own body font, e.g. Geist Sans, via
 * `vars.fontSans`) at the same quiet size/muted color reads calmer here
 * than mono would. Applies to the timestamp AND `showMoreLabel`/
 * `showLessLabel` below, so the row stays typographically uniform.
 */
export const userActionsTimestamp = style({
  fontFamily: vars.fontSans,
  fontSize: '10px',
  color: vars.fgMuted,
});

export const attachmentStrip = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: cardVars.attachGap,
  paddingBottom: cardVars.attachGap,
});

export const attachThumbBtn = style({
  display: 'block',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  borderRadius: vars.radiusMd,
  lineHeight: 0,
  selectors: {
    '&:focus-visible': {
      outline: '2px solid currentColor',
      outlineOffset: '2px',
    },
  },
});

export const attachThumb = style({
  display: 'block',
  width: cardVars.attachThumb,
  height: cardVars.attachThumb,
  borderRadius: vars.radiusMd,
  objectFit: 'cover',
  boxShadow: `0 0 0 1px ${vars.border}`,
});

export const attachPlaceholder = style({
  width: cardVars.attachThumb,
  height: cardVars.attachThumb,
  borderRadius: vars.radiusMd,
  background: vars.bg2,
  color: vars.fgMuted,
  display: 'grid',
  placeItems: 'center',
  boxShadow: `0 0 0 1px ${vars.border}`,
});

export const cardFadeOverlay = style([
  fadeOverlayBottom,
  {
    pointerEvents: 'none',
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    height: '32px',
    borderBottomLeftRadius: vars.radiusLg,
    borderBottomRightRadius: vars.radiusLg,
  },
]);

/**
 * Clamp-redesign round (Dylan's screenshot: "Show more" rendered
 * overlapping the fading last line inside the bubble): moved OUT of the
 * card entirely into the below-bubble `userActionsRow` (design-system
 * Rule 9 — actions live outside bubbles, below, muted), same quiet
 * treatment as `userActionsTimestamp` (now regular sans, not mono — see
 * that style's own comment). The fade (`cardFadeOverlay`) stays inside the
 * card as the visual truncation cue; nothing renders on top of it anymore.
 *
 * Persistent by design — a sibling of `userActionsHoverGroup`, not a child
 * of it, so it does NOT inherit that group's hover-gated opacity. A
 * clamped message's expander must always be visible, or a genuinely long
 * message just reads as content that stopped rather than something more to
 * reveal.
 *
 * `data-user-card={item.id}` duplicates the attribute the actual card
 * carries (`UserMessageCard.tsx`) so `ChatRoot.tsx`'s document-level
 * `t.closest('[data-user-card]')` click delegation still finds and toggles
 * this exact message even though the label itself now lives outside the
 * card's own DOM subtree — no separate click handler needed.
 */
export const showMoreLabel = style({
  fontFamily: vars.fontSans,
  fontSize: '10px',
  color: vars.fgMuted,
  cursor: 'pointer',
  userSelect: 'none',
  selectors: {
    '&:hover': { color: vars.fg },
  },
});

/**
 * "Show less" — hover-only is fine here, unlike `showMoreLabel` above: it's
 * only ever reachable once already expanded (nothing is hidden that the
 * user hasn't already seen), so it can live INSIDE `userActionsHoverGroup`
 * and fade with copy + timestamp exactly like the timestamp row already did
 * before this round — same convention, not a new one.
 */
export const showLessLabel = style({
  fontFamily: vars.fontSans,
  fontSize: '10px',
  color: vars.fgMuted,
  cursor: 'pointer',
  userSelect: 'none',
  selectors: {
    '&:hover': { color: vars.fg },
  },
});

// ── PinnedUserMessage ─────────────────────────────────────────────────────────

export const pinnedBackdrop = style({
  background: `color-mix(in srgb, ${vars.bg} 80%, transparent)`,
  backdropFilter: 'blur(8px)',
  pointerEvents: 'auto',
});

export const pinnedScrollFade = style([
  fadeOverlayTop,
  {
    pointerEvents: 'none',
    height: '16px',
  },
]);
