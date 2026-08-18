/**
 * scrollbar.css.ts — the one shared thin-scrollbar convention every custom
 * scroll container in this package uses (the transcript's own scroll
 * container, code blocks, execute/terminal output). Chromium/Electron
 * ignores `scrollbar-width`/`scrollbar-color` (the Firefox-only path each
 * call site still sets locally), so this covers the `::-webkit-scrollbar*`
 * pseudo-elements.
 *
 * Polish round: a flush track edge slammed the thumb's square top/bottom
 * (or left/right, for a horizontal scroller) straight into whatever rounded
 * container corner it sat inside, at either scroll extreme — the `inset`
 * param leaves a small gap so the thumb never touches that corner. The
 * thumb itself is always a full pill (`9999px`) rather than a fixed radius
 * that only happened to fully round one particular track width.
 */
import { globalStyle } from '@vanilla-extract/css';
import { vars } from './theme.css';

const INSET = '4px';

/**
 * Track + thumb theming only — `::-webkit-scrollbar` width/height stays each
 * call site's own concern (the transcript's is a fixed 8px, the execute
 * block's tracks a dynamic `--execute-scrollbar-size`).
 */
export function webkitThinScrollbar(containerSelector: string, direction: 'vertical' | 'horizontal' = 'vertical') {
  globalStyle(`${containerSelector}::-webkit-scrollbar-track`, {
    background: 'transparent',
    ...(direction === 'vertical' ? { marginBlock: INSET } : { marginInline: INSET }),
  });

  globalStyle(`${containerSelector}::-webkit-scrollbar-thumb`, {
    backgroundColor: vars.border,
    borderRadius: '9999px',
    // A transparent border clipped to the thumb's padding box insets it
    // visually from the track edge — the "thumb only" look, not a full-width bar.
    border: '2px solid transparent',
    backgroundClip: 'content-box',
  });
}
