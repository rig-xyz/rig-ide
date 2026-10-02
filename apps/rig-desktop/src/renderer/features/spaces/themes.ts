/**
 * Room themes (rig/docs/room-themes-spec.md §6, §7): the Room's themes state
 * and the pure functions that move it. The relay's snapshot lands whole
 * (`themesFromSnapshot`); its event log then applies in batches
 * (`applyThemeEvents`), keeping each theme's `count` and `lastSeq` right.
 *
 * Applying is idempotent two ways. An event at or before `cursor` is skipped,
 * so the same event arriving twice (a notice racing a catch-up) counts once.
 * And each event is written as "put this message in that theme", never as
 * "add one", so events a snapshot already reflects (the relay reads the
 * cursor before the state, so a change landing mid-snapshot replays) leave
 * the same counts.
 *
 * Counts are exact for the messages the snapshot named (its newest 5,000).
 * An older message's theme is unknown here: moving one trusts the event's
 * `from`. `lastSeq` only ever rises as events apply (a message leaving a
 * theme can't be re-ranked without the whole history); the next snapshot
 * restores it.
 */

import {
  compareEventIds,
  type RoomTheme,
  type ThemeAssignment,
  type ThemeEvent,
  type ThemesSnapshotWire,
} from '@shared/spaces/themes';

export type {
  RoomTheme,
  ThemeAssignment,
  ThemeEvent,
  ThemesSnapshotWire,
} from '@shared/spaces/themes';

/** A theme the Room heard born: its `born` event applied live, never one that came with a snapshot. */
export type ThemeBirth = { eventId: string; themeId: string; name: string };

/** How many births `RoomThemes.births` remembers: the dock only needs the ones it has not shown yet. */
const MAX_BIRTHS = 20;

export type RoomThemes = {
  /** The per-Space switch. Off: the Room has no dock, whatever else is here. */
  enabled: boolean;
  /** Active themes, oldest first. Merged-away themes are gone. */
  list: RoomTheme[];
  /** Message id → its current theme and how it got there. */
  themeOf: Record<string, ThemeAssignment>;
  /** The id of the last event applied: `events?after=` continues from here. */
  cursor: string;
  /**
   * The themes born while the Room has been open, oldest first: one entry for
   * each `born` event that `applyThemeEvents` applied. A snapshot (the first
   * load, a re-sync after a reconnect) carries none, whatever themes it has,
   * so only a live birth gets the dock's "new" tag and notice.
   */
  births?: readonly ThemeBirth[];
};

export function themesFromSnapshot(wire: ThemesSnapshotWire): RoomThemes {
  return {
    enabled: wire.enabled,
    list: wire.themes,
    themeOf: wire.assignments,
    cursor: wire.latestEventId,
  };
}

/**
 * `themes` with `events` applied, in order. `upTo` is the page's last event
 * id as the relay sent it (it may be past the last event this build knows
 * how to read); `seqOf` gives a message's seq when the Room has it, for
 * `lastSeq`. Returns `themes` itself when nothing changed.
 */
export function applyThemeEvents(
  themes: RoomThemes,
  events: readonly ThemeEvent[],
  upTo: string | null,
  seqOf: (messageId: string) => number | undefined
): RoomThemes {
  let { cursor } = themes;
  let births = themes.births;
  let list = themes.list;
  let themeOf = themes.themeOf;
  let listCopied = false;
  let themeOfCopied = false;

  const peek = (id: string): RoomTheme | undefined => list.find((t) => t.id === id);
  const mutableList = (): RoomTheme[] => {
    if (!listCopied) {
      list = list.map((t) => ({ ...t }));
      listCopied = true;
    }
    return list;
  };
  const mutableThemeOf = (): Record<string, ThemeAssignment> => {
    if (!themeOfCopied) {
      themeOf = { ...themeOf };
      themeOfCopied = true;
    }
    return themeOf;
  };
  /** A theme to change: the list is copied first (once), so the caller's `themes` is never touched. */
  const edit = (id: string): RoomTheme | undefined => mutableList().find((t) => t.id === id);
  const leave = (themeId: string | undefined): void => {
    const theme = themeId ? edit(themeId) : undefined;
    if (theme) theme.count = Math.max(0, theme.count - 1);
  };
  const join = (theme: RoomTheme, seq: number | undefined): void => {
    theme.count += 1;
    if (seq !== undefined) theme.lastSeq = Math.max(theme.lastSeq, seq);
  };

  for (const event of [...events].sort((a, b) => compareEventIds(a.id, b.id))) {
    if (compareEventIds(event.id, cursor) <= 0) continue;
    cursor = event.id;
    switch (event.type) {
      case 'born': {
        if (peek(event.themeId)) break;
        births = [
          ...(births ?? []),
          { eventId: event.id, themeId: event.themeId, name: event.name },
        ].slice(-MAX_BIRTHS);
        mutableList().push({
          id: event.themeId,
          name: event.name,
          description: event.description,
          bornSeq: event.bornSeq,
          count: 0,
          lastSeq: event.bornSeq,
        });
        break;
      }
      case 'assign': {
        const current = themeOf[event.messageId];
        if (!peek(event.themeId)) break; // a theme this Room never heard of: nothing to put it in
        if (current?.themeId === event.themeId) {
          // Already there (a snapshot reflected it): at most how it got there changes.
          if (current.via !== event.via)
            mutableThemeOf()[event.messageId] = { themeId: event.themeId, via: event.via };
          break;
        }
        leave(current?.themeId);
        join(edit(event.themeId)!, seqOf(event.messageId) ?? event.atSeq);
        mutableThemeOf()[event.messageId] = { themeId: event.themeId, via: event.via };
        break;
      }
      case 'move': {
        const current = themeOf[event.messageId];
        if (!peek(event.to) || current?.themeId === event.to) break;
        // Where the Room has the message wins; an older message's place is unknown, so trust `from`.
        leave(current?.themeId ?? event.from);
        join(edit(event.to)!, seqOf(event.messageId));
        mutableThemeOf()[event.messageId] = { themeId: event.to, via: current?.via ?? 'gardener' };
        break;
      }
      case 'rename': {
        const theme = peek(event.themeId) && edit(event.themeId);
        if (!theme) break;
        theme.name = event.name;
        if (event.description !== null) theme.description = event.description;
        break;
      }
      case 'merge': {
        if (!peek(event.into) || !peek(event.from) || event.from === event.into) break;
        const into = edit(event.into)!;
        const from = edit(event.from)!;
        into.count += from.count;
        into.lastSeq = Math.max(into.lastSeq, from.lastSeq);
        list = list.filter((t) => t.id !== event.from);
        for (const [messageId, assignment] of Object.entries(themeOf)) {
          if (assignment.themeId === event.from)
            mutableThemeOf()[messageId] = { ...assignment, themeId: event.into };
        }
        break;
      }
    }
  }

  if (upTo !== null && compareEventIds(upTo, cursor) > 0) cursor = upTo;
  if (!listCopied && !themeOfCopied && cursor === themes.cursor) return themes;
  return { enabled: themes.enabled, list, themeOf, cursor, ...(births ? { births } : {}) };
}
