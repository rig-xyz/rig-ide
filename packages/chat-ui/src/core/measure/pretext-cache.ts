/**
 * Thin helpers around pretext's `prepareRichInline`.
 *
 * The per-instance richInlineCache has moved to ChatCaches (core/caches.ts).
 * This module now exports:
 *   registerFontsReadyClear  — font-load hook; calls onCleared which should
 *                              invoke caches.clearTextMeasure() + remeasure.
 *   clearPretextInternalCaches — flush pretext's internal global caches (re-exported
 *                               for use from ChatCaches.clearTextMeasure).
 */

import type { FontConfig } from '@core/config';

export { clearCache as clearPretextInternalCaches } from '@chenglou/pretext';

/**
 * Round (post-release usage, inline-spacing bug): the warm-list used to be a
 * hardcoded 4-string array (14/13/12px Inter/JetBrains Mono, no italic spec
 * at all) — NOT derived from the live `FontConfig`. A host running a custom
 * `ChatConfig` (different sizes/weights, or the default's own `italic`/
 * `boldItalic`/`h1`/`h2`/`h3`/`link`/`mention` roles, none of which were in
 * the old list) would have `document.fonts.load()` resolve before pretext's
 * ACTUAL measurement fonts were warm. `document.fonts.load` only guarantees
 * the exact face+weight+style+size strings you pass it — an unlisted
 * variant is free to still be measuring against fallback metrics the moment
 * `onCleared` fires, producing a canvas-width/DOM-paint mismatch that shows
 * up as extra/missing space exactly at that variant's fragment boundaries
 * (inline-code chips and italic runs, in the reported case — `inline-code`
 * and `body-italic` were both absent from the old hardcoded list).
 *
 * Derived now: every `VariantMetrics.font` shorthand `toFontConfig` (in
 * `core/config.ts`) actually produces, de-duplicated — so a future config
 * change (a new role, a different size/weight) can never silently fall out
 * of the warm set the way a hand-maintained list could.
 */
export function distinctFontSpecs(fonts: FontConfig): string[] {
  return [
    ...new Set([
      fonts.body.font,
      fonts.bold.font,
      fonts.italic.font,
      fonts.boldItalic.font,
      fonts.link.font,
      fonts.h1.font,
      fonts.h2.font,
      fonts.h3.font,
      fonts.inlineCode.font,
      fonts.mention.font,
      fonts.code.font,
    ]),
  ];
}

/**
 * Eagerly load every font shorthand the resolved `FontConfig` actually uses,
 * then call `onCleared` (which should invoke `caches.clearTextMeasure()` +
 * `virtualizer.measure()`).
 *
 * Using `document.fonts.load(spec)` instead of `document.fonts.ready` ensures
 * we wait for the exact faces pretext needs, not just "all fonts document-wide".
 * Without this, pretext measures with the fallback metrics during first paint
 * and produces wrong line-break/fragment positions until the cache is cleared.
 *
 * Call this once when ChatTranscript mounts, passing the SAME `FontConfig`
 * (`theme.fonts`, from `buildChatTheme`) the rest of measurement uses — see
 * `chat-context.ts`'s one call site.
 */
export function registerFontsReadyClear(fonts: FontConfig, onCleared?: () => void): void {
  if (typeof document === 'undefined') return;
  const specs = distinctFontSpecs(fonts);
  void Promise.all(specs.map((spec) => document.fonts.load(spec))).then(() => {
    onCleared?.();
  });
}
