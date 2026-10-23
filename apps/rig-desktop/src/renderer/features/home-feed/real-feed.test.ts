import { describe, expect, it } from 'vitest';
import type { RigFeedItem } from '@shared/rig/feed';
import { age, refsToTokens, splitAction, toFeedItems } from './real-feed';

const NOW = Date.parse('2026-10-20T19:00:00Z');

const item = (id: string, d: 'ask_you' | 'do_it' | 'bring_in', card = true): RigFeedItem => ({
  situationId: id,
  title: `Situation ${id}`,
  description: `About ${id} [item:ULY-1].`,
  participants: ['Riyad Hasanov'],
  decision: { do: d, conf: 0.8, who: 'Dylan', look: 'next_event', trigger: 'new event' },
  card: card
    ? {
        title: `Card ${id}`,
        why: 'Riyad asked [ev:i04] about the registry [item:ULY-229].',
        action: '**Reply to Riyad.** Answer the vendor question.',
        refsOk: true,
      }
    : null,
  updatedAt: '2026-10-20T18:30:00Z',
});

describe('the orchestrator Feed as Home cards', () => {
  it('turns ticket refs into chips and drops refs with no readable name', () => {
    expect(refsToTokens('Riyad asked [ev:i04] about the registry [item:ULY-229].')).toBe(
      'Riyad asked about the registry {ULY-229}.'
    );
  });

  it('splits the drafted action into the button label and the rest', () => {
    expect(splitAction('**Reply to Riyad.** Answer the vendor question.')).toEqual({
      lead: 'Reply to Riyad',
      tail: ': answer the vendor question.',
    });
    expect(splitAction('Check the numbers')).toEqual({ lead: 'Check the numbers', tail: '' });
  });

  it('puts asks first, keeps Rig ids, and falls back to the situation when no card is drafted yet', () => {
    const items = toFeedItems(
      {
        visible: [item('a', 'do_it'), item('b', 'ask_you', false), item('c', 'bring_in')],
        queued: [],
        following: [],
        snoozed: [],
        digest: [],
      },
      NOW
    );
    expect(items.map((i) => [i.id, i.group, i.choices[0]!.verb])).toEqual([
      ['sit:b', 'needs_you', 'reply'],
      ['sit:c', 'needs_you', 'space'],
      ['sit:a', 'up_next', 'start'],
    ]);
    expect(items[0]!.title).toBe('Situation b');
    expect(items[0]!.why).toBe('About b {ULY-1}.');
    expect(items[1]!.situationId).toBe('c');
    expect(items[2]!.age).toBe('30m');
  });

  it('says how old a card is', () => {
    expect(age('2026-10-20T18:59:30Z', NOW)).toBe('new');
    expect(age('2026-10-19T19:00:00Z', NOW)).toBe('1d');
  });
});
