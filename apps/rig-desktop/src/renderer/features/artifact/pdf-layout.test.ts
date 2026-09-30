import { describe, expect, it } from 'vitest';
import { currentPageAt, MAX_FIT_WIDTH, pageWidthFor, stepZoom, ZOOM_STEPS } from './pdf-layout';

describe('stepZoom', () => {
  it('moves one step in or out from fit', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
  });

  it('from between steps (a pinch), goes to the next step that way', () => {
    expect(stepZoom(1.3, 1)).toBe(1.5);
    expect(stepZoom(1.3, -1)).toBe(1.25);
  });

  it('stays put at either end', () => {
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1]!, 1)).toBe(3);
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(0.5);
  });
});

describe('pageWidthFor', () => {
  it('fit is the panel width, capped for a very wide panel', () => {
    expect(pageWidthFor(388, 1)).toBe(388);
    expect(pageWidthFor(2400, 1)).toBe(MAX_FIT_WIDTH);
  });

  it('zoom scales the fit', () => {
    expect(pageWidthFor(400, 1.5)).toBe(600);
  });

  it('never collapses to nothing in a squeezed panel', () => {
    expect(pageWidthFor(0, 1)).toBe(120);
  });
});

describe('currentPageAt', () => {
  const tops = [16, 516, 1016, 1516];

  it('page 1 at the top', () => {
    expect(currentPageAt(tops, 0, 600)).toBe(1);
  });

  it('the page crossing the upper third of the view', () => {
    expect(currentPageAt(tops, 400, 600)).toBe(2); // line at 600
    expect(currentPageAt(tops, 1400, 600)).toBe(4);
  });

  it('an empty document reads as page 1', () => {
    expect(currentPageAt([], 0, 600)).toBe(1);
  });
});
