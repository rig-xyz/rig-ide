import { describe, expect, it } from 'vitest';
import { QUICK_REACTIONS, reactionCounts, withReaction } from '@shared/spaces/reactions';
import { loadEmojiIndex, matchShortcodes, searchEmoji } from './emoji-data';

describe('the emoji index (emojibase data, GitHub shortcodes)', () => {
  it('holds every category but the skin-tone building blocks, spelled as the relay stores them', async () => {
    const index = await loadEmojiIndex();
    expect(index.groups.map((g) => g.label)).toEqual([
      'Smileys & emotion',
      'People & body',
      'Animals & nature',
      'Food & drink',
      'Travel & places',
      'Activities',
      'Objects',
      'Symbols',
      'Flags',
    ]);
    expect(index.entries.length).toBeGreaterThan(1500);
    const emoji = new Set(index.entries.map((e) => e.emoji));
    // The quick five are all in it, with the same spelling.
    for (const quick of QUICK_REACTIONS) expect(emoji.has(quick)).toBe(true);
    expect(emoji.has('👍')).toBe(true);
    expect(emoji.has('👍️')).toBe(false);
    expect(emoji.has('🏻')).toBe(false);
  });

  it('matches shortcodes for the composer: an exact one first, then by length', async () => {
    const index = await loadEmojiIndex();
    const tada = matchShortcodes(index, 'tada');
    expect(tada[0]).toMatchObject({ entry: { emoji: '🎉' }, shortcode: 'tada' });
    const ta = matchShortcodes(index, 'ta');
    expect(ta.length).toBeLessThanOrEqual(8);
    expect(ta.every((m) => m.shortcode.startsWith('ta'))).toBe(true);
    expect(matchShortcodes(index, 'thumbsu')[0]!.entry.emoji).toBe('👍');
    expect(matchShortcodes(index, 'zzzqqq')).toEqual([]);
  });

  it('searches the picker by shortcode, name and tag', async () => {
    const index = await loadEmojiIndex();
    expect(searchEmoji(index, 'tada')[0]!.emoji).toBe('🎉');
    expect(searchEmoji(index, ':heart:')[0]!.emoji).toBe('❤️');
    expect(searchEmoji(index, 'party').map((e) => e.emoji)).toContain('🎉');
    expect(searchEmoji(index, 'eyes')[0]!.emoji).toBe('👀');
    expect(searchEmoji(index, '   ')).toEqual([]);
  });
});

describe('reaction helpers', () => {
  it('counts only, never names', () => {
    expect(
      reactionCounts([
        { emoji: '👍', count: 4, reactors: [{ userId: 'u1', agent: null }] },
        { emoji: '🎉', count: 2, reactors: [{ userId: 'u2', agent: 'claude' }] },
      ])
    ).toBe('👍 4 🎉 2');
    expect(reactionCounts(undefined)).toBe('');
  });

  it('toggles one reactor on and off without touching the others', () => {
    const sam = { userId: 'sam', agent: null };
    const me = { userId: 'me', agent: null };
    const myClaude = { userId: 'me', agent: 'claude' as const };
    const start = [{ emoji: '👍', count: 1, reactors: [sam] }];
    const on = withReaction(start, '👍', me, true);
    expect(on).toEqual([{ emoji: '👍', count: 2, reactors: [sam, me] }]);
    expect(withReaction(on, '👍', me, true)).toEqual(on);
    // Your agent's reaction isn't yours.
    expect(withReaction(withReaction(on, '👍', myClaude, true), '👍', me, false)).toEqual([
      { emoji: '👍', count: 2, reactors: [sam, myClaude] },
    ]);
    expect(withReaction(start, '👍', sam, false)).toEqual([]);
    expect(withReaction(start, '🎉', me, true)).toEqual([
      ...start,
      { emoji: '🎉', count: 1, reactors: [me] },
    ]);
  });
});
