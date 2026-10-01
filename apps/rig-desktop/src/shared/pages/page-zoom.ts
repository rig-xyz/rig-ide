import { BROWSER_ZOOM_FACTORS, normalizeBrowserZoomFactor } from '../browser';
import { defineEvent } from '../lib/ipc/events';

/**
 * Zoom for a page open beside the chat. A `<webview>` otherwise takes the
 * app window's own zoom, and Chromium remembers a host's zoom in the pages
 * profile for good, so a page could open (and stay) very zoomed in. The
 * panel sets it itself instead: fit to the panel's width until you choose a
 * zoom for the site, then yours, remembered per site.
 *
 * A factor here is relative to the app's own zoom (100% = the app's scale).
 */

/** The page width (CSS px) fit aims for: enough for most sites' desktop layout. */
export const PAGE_FIT_WIDTH = 1024;
/** Fit never shrinks a page below this (text stays readable); ⌘− still can. */
export const PAGE_FIT_MIN = 0.67;

/** The fitted zoom for a panel this wide: the largest step that shows `PAGE_FIT_WIDTH`, between `PAGE_FIT_MIN` and 100%. */
export function fitPageZoom(panelWidth: number): number {
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return 1;
  const raw = panelWidth / PAGE_FIT_WIDTH;
  if (raw >= 1) return 1;
  // Snapped down to a step, so the page reflows only at a step, not on every pixel of a divider drag.
  const step = [...BROWSER_ZOOM_FACTORS].reverse().find((f) => f <= raw + 0.001) ?? BROWSER_ZOOM_FACTORS[0];
  return Math.max(PAGE_FIT_MIN, step);
}

/** The site a page's zoom is remembered for: its host, without `www.`. */
export function pageZoomSite(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

/** The page's zoom: yours for the site when you chose one, else the fit. */
export function effectivePageZoom(chosen: number | null, panelWidth: number): number {
  return chosen === null ? fitPageZoom(panelWidth) : normalizeBrowserZoomFactor(chosen);
}

export type PageZoomKey = 'in' | 'out' | 'reset';

/** ⌘+ / ⌘= / ⌘− / ⌘0 (Ctrl elsewhere) as a zoom key; null for any other input. */
export function pageZoomKeyOf(input: {
  type: string;
  key: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
}, isMac: boolean): PageZoomKey | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  if (!(isMac ? input.meta : input.control)) return null;
  if (input.key === '+' || input.key === '=') return 'in';
  if (input.key === '-' || input.key === '_') return 'out';
  if (input.key === '0') return 'reset';
  return null;
}

/**
 * ⌘+/⌘−/⌘0 (or a pinch / Ctrl-scroll) on a panel page. The page has the
 * keys, not the app, so main catches them before the menu's own zoom (which
 * would zoom the page's whole host) and tells the panel.
 */
export const pageZoomKeyChannel = defineEvent<{ webContentsId: number; key: PageZoomKey }>('rig:page-zoom-key');
