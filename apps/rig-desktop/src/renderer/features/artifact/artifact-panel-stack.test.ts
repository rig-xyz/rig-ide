import { describe, expect, it } from 'vitest';
import { BROWSER_STATE, isFileView, popToBrowser, pushFile } from './artifact-panel-stack';

describe('artifact-panel-stack', () => {
  it('starts at the browser with nothing to reveal', () => {
    expect(BROWSER_STATE).toEqual({ view: 'browser', revealPath: null });
  });

  it('pushFile enters the file view for that path', () => {
    const state = pushFile('/rig/notes.md');
    expect(state).toEqual({ view: 'file', path: '/rig/notes.md' });
    expect(isFileView(state)).toBe(true);
  });

  it('popToBrowser with no argument returns to the root with nothing to reveal', () => {
    expect(popToBrowser()).toEqual({ view: 'browser', revealPath: null });
  });

  it('popToBrowser with a path reveals that folder', () => {
    expect(popToBrowser('docs/progression')).toEqual({
      view: 'browser',
      revealPath: 'docs/progression',
    });
  });

  it('isFileView narrows correctly for the browser state', () => {
    expect(isFileView(BROWSER_STATE)).toBe(false);
  });
});
