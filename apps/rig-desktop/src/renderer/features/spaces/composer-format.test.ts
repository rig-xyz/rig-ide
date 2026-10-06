import { describe, expect, it } from 'vitest';
import { formatMarkerFor, toggleMarker, type FormatEdit } from './composer-format';

function apply(value: string, edit: FormatEdit): string {
  const next = value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
  return `${next.slice(0, edit.selStart)}[${next.slice(edit.selStart, edit.selEnd)}]${next.slice(edit.selEnd)}`;
}

/** `[` and `]` mark the selection. */
function press(marked: string, marker: string): string {
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  const value = marked.replace('[', '').replace(']', '');
  return apply(value, toggleMarker(value, start, end, marker));
}

describe('toggleMarker', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(press('make [this] bold', '**')).toBe('make **[this]** bold');
    expect(press('run [npm i] now', '`')).toBe('run `[npm i]` now');
    expect(press('[so]', '_')).toBe('_[so]_');
  });

  it('puts a pair around the cursor', () => {
    expect(press('say []', '**')).toBe('say **[]**');
    expect(press('[]', '`')).toBe('`[]`');
  });

  it('takes the markers off again', () => {
    expect(press('make **[this]** bold', '**')).toBe('make [this] bold');
    expect(press('make [**this**] bold', '**')).toBe('make [this] bold');
    expect(press('say **[]**', '**')).toBe('say []');
  });

  it('leaves spaces at the edges of the selection outside', () => {
    expect(press('a[ word ]b', '**')).toBe('a **[word]** b');
  });
});

describe('formatMarkerFor', () => {
  const key = (
    k: string,
    mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}
  ) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('is ⌘B / ⌘I / ⌘E on a Mac, and leaves Ctrl-B / Ctrl-E to move the cursor', () => {
    expect(formatMarkerFor(key('b', { metaKey: true }), true)).toBe('**');
    expect(formatMarkerFor(key('i', { metaKey: true }), true)).toBe('_');
    expect(formatMarkerFor(key('E', { metaKey: true }), true)).toBe('`');
    expect(formatMarkerFor(key('b', { ctrlKey: true }), true)).toBeNull();
    expect(formatMarkerFor(key('e', { ctrlKey: true }), true)).toBeNull();
  });

  it('is Ctrl elsewhere, and ignores other keys and modifiers', () => {
    expect(formatMarkerFor(key('b', { ctrlKey: true }), false)).toBe('**');
    expect(formatMarkerFor(key('b', { metaKey: true }), false)).toBeNull();
    expect(formatMarkerFor(key('b', { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(formatMarkerFor(key('b', { metaKey: true, altKey: true }), true)).toBeNull();
    expect(formatMarkerFor(key('k', { metaKey: true }), true)).toBeNull();
    expect(formatMarkerFor(key('b'), true)).toBeNull();
  });
});
