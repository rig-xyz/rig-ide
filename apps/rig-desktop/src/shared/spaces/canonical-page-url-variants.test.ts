import { describe, expect, it } from 'vitest';
import { canonicalPageUrl, legacyPagePaths } from './links';

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

describe('legacyPagePaths: pins stored before one key per document', () => {
  it("reads a Google Doc's old edit and view keys, and the link as it was stored", () => {
    expect(legacyPagePaths('https://docs.google.com/document/u/1/d/1AbC/edit?usp=sharing#h.x')).toEqual([
      'https://docs.google.com/document/u/1/d/1AbC/edit',
      'https://docs.google.com/document/d/1AbC/edit',
      'https://docs.google.com/document/d/1AbC/view',
    ]);
  });

  it("reads a sheet tab's old key, which had no tab", () => {
    expect(legacyPagePaths('https://docs.google.com/spreadsheets/d/1AbC/edit#gid=5')).toEqual([
      'https://docs.google.com/spreadsheets/d/1AbC/edit',
      'https://docs.google.com/spreadsheets/d/1AbC/view',
    ]);
  });

  it("reads a Claude artifact's old key with its slug, and nothing for a link whose key didn't change", () => {
    expect(legacyPagePaths('https://claude.ai/artifact/pilot-plan-6NZfLXaEewFt55zQ5tMn7d')).toEqual([
      'https://claude.ai/artifact/pilot-plan-6NZfLXaEewFt55zQ5tMn7d',
    ]);
    expect(legacyPagePaths('https://example.com/report?id=7#s2')).toEqual([]);
  });

  it('keeps a UUID artifact link as it is', () => {
    const url = 'https://claude.ai/code/artifact/0b7a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    expect(canonicalPageUrl(url)).toBe(url);
  });
});
