import { describe, expect, it } from 'vitest';
import type { RigRecentTheme } from '@shared/rig/recent-themes';
import { parseRecentThemes } from '@shared/rig/recent-themes';
import {
  deriveAcrossSpacesView,
  moreTopicsLabel,
  splitRecentThemes,
  themeActivityLine,
  topicBySpace,
  withTopic,
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

describe('withTopic', () => {
  it('leads the status line with the topic', () => {
    expect(withTopic('Bugs & Wishlist', "Hugo's Claude finished · 20m ago")).toBe(
      "Bugs & Wishlist · Hugo's Claude finished · 20m ago"
    );
    expect(withTopic(null, '2h ago')).toBe('2h ago');
    expect(withTopic('Bugs', 'No activity yet')).toBe('Bugs');
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
