/**
 * Room themes with activity in the last 24h across the account's spaces —
 * the wire shape of `GET /v1/me/themes/recent` (tap `packages/relay/src/
 * routes/themes.ts`). Shared by the main-process client
 * (`main/rig/recent-themes.ts`) and Home, which reads it once for both the
 * "Across your spaces today" cards and each Spaces row's topic.
 */

export type RigRecentTheme = {
  themeId: string;
  bindingId: string;
  spaceName: string;
  name: string;
  /** The theme's one line, written by the relay's themes worker. */
  description: string;
  /** Messages the theme gained in the last 24h. */
  messageCount: number;
  /** Who wrote them, most recent first: "Hugo", "Hugo's Claude". */
  people: string[];
  lastActivityAt: string;
  /** Seq of the theme's newest message in the window. */
  lastSeq: number;
};

/**
 * What Home gets: the relay's answer, or this account's last one from this
 * computer when the relay can't be reached (`cached`), or nothing at all.
 */
export type RigRecentThemes =
  | { kind: 'live'; themes: RigRecentTheme[]; savedAt: number }
  | { kind: 'cached'; themes: RigRecentTheme[]; savedAt: number }
  | { kind: 'none' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function toTheme(value: unknown): RigRecentTheme | null {
  const r = asRecord(value);
  if (
    !r ||
    typeof r.themeId !== 'string' ||
    typeof r.bindingId !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.lastActivityAt !== 'string'
  ) {
    return null;
  }
  const count = Number(r.messageCount);
  const seq = Number(r.lastSeq);
  return {
    themeId: r.themeId,
    bindingId: r.bindingId,
    spaceName: typeof r.spaceName === 'string' ? r.spaceName : '',
    name: r.name,
    description: typeof r.description === 'string' ? r.description : '',
    messageCount: Number.isFinite(count) && count > 0 ? count : 0,
    people: Array.isArray(r.people)
      ? r.people.filter((p): p is string => typeof p === 'string' && p !== '')
      : [],
    lastActivityAt: r.lastActivityAt,
    lastSeq: Number.isFinite(seq) ? seq : 0,
  };
}

/** The relay's `{ themes: [...] }`, or null when the body isn't that shape. Malformed entries are dropped. */
export function parseRecentThemes(body: unknown): RigRecentTheme[] | null {
  const list = asRecord(body)?.themes;
  if (!Array.isArray(list)) return null;
  return list.map(toTheme).filter((t): t is RigRecentTheme => t !== null);
}
