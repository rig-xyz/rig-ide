import { describe, expect, it } from 'vitest';
import { effectivePageZoom, fitPageZoom, PAGE_FIT_MIN, pageZoomKeyOf, pageZoomSite } from './page-zoom';

describe('page zoom', () => {
  it('fits a typical site to the panel: 100% when wide enough, a step down when narrower, never below the floor', () => {
    expect(fitPageZoom(1400)).toBe(1);
    expect(fitPageZoom(1024)).toBe(1);
    expect(fitPageZoom(1000)).toBe(0.9); // snapped down to a step
    expect(fitPageZoom(820)).toBe(0.8);
    expect(fitPageZoom(780)).toBe(0.75);
    expect(fitPageZoom(700)).toBe(0.67);
    expect(fitPageZoom(420)).toBe(PAGE_FIT_MIN);
    // The page gets at least ~the fit width, never a phone layout at a desktop split.
    for (const w of [700, 780, 820, 1000]) expect(w / fitPageZoom(w)).toBeGreaterThanOrEqual(1000);
    expect(fitPageZoom(0)).toBe(1);
    expect(fitPageZoom(Number.NaN)).toBe(1);
  });

  it("uses the zoom you chose for the site over the fit, whatever the panel's width", () => {
    expect(effectivePageZoom(null, 820)).toBe(0.8);
    expect(effectivePageZoom(1.25, 820)).toBe(1.25);
    expect(effectivePageZoom(99, 820)).toBe(5); // clamped to the steps' range
  });

  it('remembers zoom per site: the host without www', () => {
    expect(pageZoomSite('https://www.example.com/a?b')).toBe('example.com');
    expect(pageZoomSite('https://docs.google.com/document/d/1')).toBe('docs.google.com');
    expect(pageZoomSite('not a url')).toBeNull();
  });

  it('reads ⌘+ / ⌘= / ⌘− / ⌘0 (Ctrl off the Mac) as zoom keys, and nothing else', () => {
    const down = (key: string, mods: { meta?: boolean; control?: boolean; alt?: boolean } = { meta: true }) => ({ type: 'keyDown', key, ...mods });
    expect(pageZoomKeyOf(down('+'), true)).toBe('in');
    expect(pageZoomKeyOf(down('='), true)).toBe('in');
    expect(pageZoomKeyOf(down('-'), true)).toBe('out');
    expect(pageZoomKeyOf(down('0'), true)).toBe('reset');
    expect(pageZoomKeyOf(down('0', { control: true }), false)).toBe('reset');
    expect(pageZoomKeyOf(down('0', { control: true }), true)).toBeNull(); // Ctrl on the Mac is not ⌘
    expect(pageZoomKeyOf(down('='), false)).toBeNull();
    expect(pageZoomKeyOf(down('=', { meta: true, alt: true }), true)).toBeNull();
    expect(pageZoomKeyOf({ type: 'keyUp', key: '=', meta: true }, true)).toBeNull();
    expect(pageZoomKeyOf(down('c'), true)).toBeNull();
  });
});
