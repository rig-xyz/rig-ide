/**
 * The composer's formatting keys (⌘B bold, ⌘I italics, ⌘E code): wrap the
 * selection in the markdown markers, or put a pair around the cursor. On a
 * selection (or cursor) already wrapped in them, the markers come off.
 * Spaces at the selection's edges stay outside the markers, since
 * `** bold **` isn't bold.
 */

const FORMAT_KEYS: Readonly<Record<string, string>> = { b: '**', i: '_', e: '`' };

type KeyLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * The marker a key press asks for, or null. ⌘ on a Mac, Ctrl elsewhere: on a
 * Mac, Ctrl-B and Ctrl-E keep moving the cursor as they do in any text field.
 */
export function formatMarkerFor(event: KeyLike, mac: boolean): string | null {
  if (event.altKey || event.shiftKey) return null;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  return FORMAT_KEYS[event.key.toLowerCase()] ?? null;
}

/** Replace `[from, to)` with `insert`, then select `[selStart, selEnd)`. */
export type FormatEdit = {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
};

export function toggleMarker(
  value: string,
  start: number,
  end: number,
  marker: string
): FormatEdit {
  const m = marker.length;
  // Markers just outside the selection: take them off.
  if (
    start >= m &&
    value.slice(start - m, start) === marker &&
    value.slice(end, end + m) === marker
  ) {
    return {
      from: start - m,
      to: end + m,
      insert: value.slice(start, end),
      selStart: start - m,
      selEnd: end - m,
    };
  }
  const selected = value.slice(start, end);
  // The selection includes its markers: take them off.
  if (selected.length >= 2 * m && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(m, -m);
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length };
  }
  const lead = /^\s*/.exec(selected)![0].length;
  const trail = selected.length === lead ? 0 : /\s*$/.exec(selected)![0].length;
  const from = start + lead;
  const to = end - trail;
  return {
    from,
    to,
    insert: `${marker}${value.slice(from, to)}${marker}`,
    selStart: from + m,
    selEnd: to + m,
  };
}
