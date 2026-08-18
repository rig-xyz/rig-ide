import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, fontShorthand, toFontConfig, type ChatConfig, type FontConfig } from '@core/config';
import { distinctFontSpecs } from './pretext-cache';

/**
 * Round (post-release usage, inline-spacing bug): root-caused to
 * `registerFontsReadyClear`'s warm-list being a hardcoded 4-string array
 * that never included `italic`/`boldItalic`/`link`/`h1`/`h2`/`h3`/`mention`
 * at all, and matched `inlineCode`/`code`/`body`/`bold` only by
 * coincidence (their sizes happened to line up with the hardcoded
 * strings). `document.fonts.load()` only guarantees the exact strings you
 * pass it — an unlisted variant could still be measuring against fallback
 * metrics when `onCleared` fired, producing the extra space Dylan saw
 * exactly at inline-code chip and italic-run boundaries.
 *
 * `distinctFontSpecs` is now DERIVED from `FontConfig` — these tests pin
 * that derivation independently of `pretext-cache.ts`'s own implementation
 * (walking `FontConfig`'s actual shape via `Object.values`, not copying
 * the same field list `distinctFontSpecs` uses internally), so a future
 * `FontConfig` field that isn't wired into `distinctFontSpecs` fails here
 * rather than silently falling out of the warm set again.
 */

function allVariantFontStrings(fonts: FontConfig): Set<string> {
  return new Set(
    Object.values(fonts)
      .filter((v): v is { font: string; lineHeight: number } => typeof v === 'object' && v !== null && 'font' in v)
      .map((v) => v.font)
  );
}

describe('distinctFontSpecs', () => {
  it('covers every distinct .font string the default FontConfig produces — no role silently missing from the warm set', () => {
    const fonts = toFontConfig(DEFAULT_CONFIG);
    expect(new Set(distinctFontSpecs(fonts))).toEqual(allVariantFontStrings(fonts));
  });

  it('the two reported-broken cases — inline code chip and italic runs — are genuinely in the warm list', () => {
    const fonts = toFontConfig(DEFAULT_CONFIG);
    const specs = distinctFontSpecs(fonts);
    expect(specs).toContain(fonts.inlineCode.font);
    expect(specs).toContain(fonts.italic.font);
    expect(specs).toContain(fonts.boldItalic.font);
  });

  it('never returns duplicates, even when two roles happen to share the same shorthand', () => {
    const fonts = toFontConfig(DEFAULT_CONFIG);
    const specs = distinctFontSpecs(fonts);
    expect(specs.length).toBe(new Set(specs).size);
  });

  it('genuinely derived, not hardcoded — a custom config changes the warm list to match', () => {
    const custom: ChatConfig = {
      ...DEFAULT_CONFIG,
      roles: {
        ...DEFAULT_CONFIG.roles,
        h1: { family: 'sans', size: 99, weight: 900, lineHeight: 120 },
      },
    };
    const customFonts = toFontConfig(custom);
    const specs = distinctFontSpecs(customFonts);
    const expectedH1 = fontShorthand(custom.roles.h1, custom.fonts.sans.join(', '));

    expect(specs).toContain(expectedH1);
    // The default config's own (now-superseded) h1 size never leaks in.
    expect(specs).not.toContain(toFontConfig(DEFAULT_CONFIG).h1.font);
  });
});
