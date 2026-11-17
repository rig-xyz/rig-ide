import { describe, expect, it } from 'vitest';
import {
  hideTab,
  orderTabs,
  parseTabPrefs,
  pruneTabPrefs,
  showTab,
  withViewTitle,
} from './tab-prefs';

describe('tab prefs', () => {
  it('reads what was stored, and nothing from anything else', () => {
    expect(parseTabPrefs('{"order":["b","a",3],"hidden":["c"]}')).toEqual({
      order: ['b', 'a'],
      hidden: ['c'],
    });
    expect(parseTabPrefs('nope')).toEqual({ order: [], hidden: [] });
    expect(parseTabPrefs(null)).toEqual({ order: [], hidden: [] });
  });
  it("orders by the person's order; unplaced names follow in their own order", () => {
    expect(orderTabs(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
    expect(orderTabs(['a', 'b'], ['gone', 'b'])).toEqual(['b', 'a']);
    // Tabs the person never placed follow the order the views ask for, then as they came.
    const asked = (name: string) => ({ c: 1, a: 2 })[name] ?? null;
    expect(orderTabs(['a', 'b', 'c', 'd'], [], asked)).toEqual(['c', 'a', 'b', 'd']);
    expect(orderTabs(['a', 'b', 'c', 'd'], ['d'], asked)).toEqual(['d', 'c', 'a', 'b']);
  });
  it('hides once, shows again, and forgets views that are gone', () => {
    const hidden = hideTab(hideTab({ order: ['a'], hidden: [] }, 'b'), 'b');
    expect(hidden.hidden).toEqual(['b']);
    expect(showTab(hidden, 'b').hidden).toEqual([]);
    expect(pruneTabPrefs({ order: ['a', 'x'], hidden: ['y', 'b'] }, ['a', 'b'])).toEqual({
      order: ['a'],
      hidden: ['b'],
    });
  });
});

describe('withViewTitle', () => {
  it('sets the title and keeps the rest', () => {
    const next = withViewTitle('{"kind":"queue","title":"Old","every":"1h"}', '  New   name ');
    expect(JSON.parse(next!)).toEqual({ kind: 'queue', title: 'New name', every: '1h' });
  });
  it('writes a view.json when there was none', () => {
    expect(JSON.parse(withViewTitle(null, 'Inbox')!)).toEqual({ title: 'Inbox' });
  });
  it('leaves an empty title and an unreadable file alone', () => {
    expect(withViewTitle('{"kind":"queue"}', '   ')).toBeNull();
    expect(withViewTitle('{broken', 'Name')).toBeNull();
    expect(withViewTitle('[1]', 'Name')).toBeNull();
  });
});
