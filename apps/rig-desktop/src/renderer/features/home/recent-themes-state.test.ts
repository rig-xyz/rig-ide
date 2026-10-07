import { describe, expect, it } from 'vitest';
import type { RigRecentTheme } from '@shared/rig/recent-themes';
import { parseRecentThemes } from '@shared/rig/recent-themes';
import {
  avatarsByFirstName,
  deriveAcrossSpacesView,
  firstNameKey,
  lastActivityByPerson,
  moreTopicsLabel,
  shortAge,
  splitRecentThemes,
  themeActivityLine,
  themeFaces,
  topicBySpace,
} from './recent-themes-state';

function theme(id: string, over: Partial<RigRecentTheme> = {}): RigRecentTheme {
  return {
    themeId: id,
    bindingId: 'b1',
    spaceName: 'Launch',
    name: id,
    description: '',
    messageCount: 1,
    people: [],
    lastActivityAt: '2026-10-02T10:00:00.000Z',
    lastSeq: 1,
    ...over,
  };
}

describe('splitRecentThemes', () => {
  it('shows the five newest and keeps the rest for "N more topics"', () => {
    const themes = Array.from({ length: 7 }, (_, i) =>
      theme(`t${i}`, { lastActivityAt: `2026-10-02T0${i}:00:00.000Z` })
    );
    const { shown, more } = splitRecentThemes(themes);
    expect(shown.map((t) => t.themeId)).toEqual(['t6', 't5', 't4', 't3', 't2']);
    expect(more.map((t) => t.themeId)).toEqual(['t1', 't0']);
    expect(moreTopicsLabel(more.length)).toBe('2 more topics');
    expect(moreTopicsLabel(1)).toBe('1 more topic');
  });

  it('five or fewer: nothing more', () => {
    expect(splitRecentThemes([theme('a'), theme('b')]).more).toEqual([]);
  });

  it('same time: the later message first', () => {
    const { shown } = splitRecentThemes([theme('a', { lastSeq: 3 }), theme('b', { lastSeq: 9 })]);
    expect(shown.map((t) => t.themeId)).toEqual(['b', 'a']);
  });
});

describe('themeActivityLine', () => {
  it('counts messages and names who wrote them', () => {
    expect(
      themeActivityLine(theme('a', { messageCount: 5, people: ['Hugo', "Hugo's Claude"] }))
    ).toBe("5 new messages · Hugo, Hugo's Claude");
    expect(themeActivityLine(theme('a', { messageCount: 1, people: ['Mia'] }))).toBe(
      '1 new message · Mia'
    );
    expect(themeActivityLine(theme('a', { messageCount: 2 }))).toBe('2 new messages');
  });

  it('names three, then "and N more"', () => {
    expect(
      themeActivityLine(theme('a', { messageCount: 9, people: ['A', 'B', 'C', 'D', 'E'] }))
    ).toBe('9 new messages · A, B, C and 2 more');
  });
});

describe('topicBySpace', () => {
  it("picks each space's theme with the most messages, ties to the most recent", () => {
    const topics = topicBySpace([
      theme('small', { messageCount: 2, lastActivityAt: '2026-10-02T12:00:00.000Z' }),
      theme('big', { messageCount: 5, lastActivityAt: '2026-10-02T08:00:00.000Z' }),
      theme('tie-old', {
        bindingId: 'b2',
        messageCount: 3,
        lastActivityAt: '2026-10-02T08:00:00.000Z',
      }),
      theme('tie-new', {
        bindingId: 'b2',
        messageCount: 3,
        lastActivityAt: '2026-10-02T09:00:00.000Z',
      }),
    ]);
    expect(topics.get('b1')?.themeId).toBe('big');
    expect(topics.get('b2')?.themeId).toBe('tie-new');
    expect(topics.has('b3')).toBe(false);
  });
});

describe('deriveAcrossSpacesView', () => {
  const live = { kind: 'live' as const, themes: [theme('a')], savedAt: 1 };
  const cached = { kind: 'cached' as const, themes: [theme('old')], savedAt: 0 };

  it('the live answer wins, the cached one stands in until then', () => {
    expect(deriveAcrossSpacesView({ live, cached, offline: false })).toEqual({
      kind: 'themes',
      themes: live.themes,
    });
    expect(deriveAcrossSpacesView({ live: undefined, cached, offline: false })).toEqual({
      kind: 'themes',
      themes: cached.themes,
    });
  });

  it('a quiet day, loading, and offline with nothing kept', () => {
    expect(
      deriveAcrossSpacesView({
        live: { kind: 'live', themes: [], savedAt: 1 },
        cached,
        offline: false,
      })
    ).toEqual({
      kind: 'empty',
    });
    expect(deriveAcrossSpacesView({ live: undefined, cached: undefined, offline: false })).toEqual({
      kind: 'loading',
    });
    expect(
      deriveAcrossSpacesView({ live: undefined, cached: { kind: 'none' }, offline: true })
    ).toEqual({
      kind: 'offline',
    });
    expect(
      deriveAcrossSpacesView({ live: { kind: 'none' }, cached: { kind: 'none' }, offline: false })
    ).toEqual({
      kind: 'offline',
    });
  });
});

describe('parseRecentThemes', () => {
  it('reads the relay body and drops what is malformed', () => {
    expect(
      parseRecentThemes({
        themes: [
          {
            themeId: 't1',
            bindingId: 'b1',
            spaceName: 'Launch',
            name: 'Bugs',
            description: 'Things to fix',
            messageCount: 4,
            people: ['Hugo', 7],
            lastActivityAt: '2026-10-02T10:00:00.000Z',
            lastSeq: '42',
          },
          { themeId: 'broken' },
        ],
      })
    ).toEqual([
      {
        themeId: 't1',
        bindingId: 'b1',
        spaceName: 'Launch',
        name: 'Bugs',
        description: 'Things to fix',
        messageCount: 4,
        people: ['Hugo'],
        lastActivityAt: '2026-10-02T10:00:00.000Z',
        lastSeq: 42,
      },
    ]);
    expect(parseRecentThemes({ nope: true })).toBeNull();
  });
});

describe('shortAge', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('says "now" under a minute, then minutes, hours and days, with no "ago"', () => {
    expect(shortAge(ago(20_000), now)).toBe('now');
    expect(shortAge(ago(4 * 60_000), now)).toBe('4m');
    expect(shortAge(ago(59 * 60_000 + 59_000), now)).toBe('59m');
    expect(shortAge(ago(60 * 60_000), now)).toBe('1h');
    expect(shortAge(ago(23 * 3_600_000 + 59 * 60_000), now)).toBe('23h');
    expect(shortAge(ago(49 * 3_600_000), now)).toBe('2d');
  });

  it('a time ahead of the clock is "now", and an unreadable one is empty', () => {
    expect(shortAge(new Date(now + 60_000).toISOString(), now)).toBe('now');
    expect(shortAge('not a date', now)).toBe('');
  });
});

describe('themeFaces', () => {
  it('shows an agent as its owner, each person once, in order', () => {
    expect(themeFaces(["Hugo's Claude", 'Ana', 'Hugo', "Ana's Codex", "Lea's An agent"])).toEqual([
      'Hugo',
      'Ana',
      'Lea',
    ]);
  });

  it('keeps a guest or a plain name as it is', () => {
    expect(themeFaces(['A guest', 'Sam'])).toEqual(['A guest', 'Sam']);
  });
});

describe('firstNameKey', () => {
  it("is a name's first word, lowercased, or null without one", () => {
    expect(firstNameKey('Hugo Martin')).toBe('hugo');
    expect(firstNameKey('  hugo ')).toBe('hugo');
    expect(firstNameKey('')).toBeNull();
    expect(firstNameKey(null)).toBeNull();
  });
});

describe('lastActivityByPerson', () => {
  it("each person's newest theme, their agents included", () => {
    const at = lastActivityByPerson([
      theme('a', { people: ['Hugo'], lastActivityAt: '2026-10-02T09:00:00.000Z' }),
      theme('b', { people: ["Hugo's Claude", 'Ana'], lastActivityAt: '2026-10-02T11:00:00.000Z' }),
      theme('c', { people: ['Ana'], lastActivityAt: '2026-10-02T10:00:00.000Z' }),
    ]);
    expect(at.get('hugo')).toBe('2026-10-02T11:00:00.000Z');
    expect(at.get('ana')).toBe('2026-10-02T11:00:00.000Z');
    expect(at.has('lea')).toBe(false);
  });
});

describe('avatarsByFirstName', () => {
  it("finds a face Pulse's briefing left out, from your people", () => {
    const pulse = [{ name: 'Hugo Renaudin', avatarUrl: 'hugo.png' }];
    const people = [{ name: 'Jérémie Rappaz', avatarUrl: 'jeremie.png' }];
    const avatars = avatarsByFirstName([], people, pulse);
    expect(avatars.get(firstNameKey('Jérémie')!)).toBe('jeremie.png');
    expect(avatars.get('hugo')).toBe('hugo.png');
  });

  it('keeps the first picture for a first name, and skips people without one', () => {
    const avatars = avatarsByFirstName(
      [{ name: 'Dylan Bourgeois', avatarUrl: 'me.png' }],
      [
        { name: 'Dylan Other', avatarUrl: 'other.png' },
        { name: 'Ada', avatarUrl: null },
      ]
    );
    expect(avatars.get('dylan')).toBe('me.png');
    expect(avatars.has('ada')).toBe(false);
  });
});
