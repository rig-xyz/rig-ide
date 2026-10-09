import { describe, expect, it } from 'vitest';
import { canonicalPageUrl } from './links';

/**
 * Comments and pins spike (rig docs/comments-pins-spike.md), surface 4.
 * Fails today.
 *
 * A page's pins are the threads whose path is its canonical link
 * (`pages-controller.ts` `threads`/`comment`). Two members who open the same
 * Google Doc or Claude artifact from links that differ only in how they were
 * copied see two separate sets of pins. And a spreadsheet's tabs, which
 * differ only in `#gid`, share one set, so a pin made on one tab is drawn on
 * every tab.
 */

describe('canonicalPageUrl: one document, one set of pins', () => {
  it.each([
    ['view instead of edit', 'https://docs.google.com/document/d/1AbC/view'],
    ['a second Google account', 'https://docs.google.com/document/u/1/d/1AbC/edit'],
    ['no trailing action', 'https://docs.google.com/document/d/1AbC/'],
    ['preview', 'https://docs.google.com/document/d/1AbC/preview'],
  ])('a Google Doc link with %s matches the plain edit link', (_why, variant) => {
    expect(canonicalPageUrl(variant)).toBe(canonicalPageUrl('https://docs.google.com/document/d/1AbC/edit'));
  });

  it('a Claude artifact link with its title slug matches the bare one', () => {
    expect(canonicalPageUrl('https://claude.ai/artifact/pilot-plan-6NZfLXaEewFt55zQ5tMn7d')).toBe(
      canonicalPageUrl('https://claude.ai/artifact/6NZfLXaEewFt55zQ5tMn7d')
    );
  });

  it("keeps a spreadsheet's tabs apart", () => {
    expect(canonicalPageUrl('https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0')).not.toBe(
      canonicalPageUrl('https://docs.google.com/spreadsheets/d/1AbC/edit#gid=482910')
    );
  });
});
