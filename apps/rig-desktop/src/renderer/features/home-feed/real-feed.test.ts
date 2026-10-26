import { describe, expect, it } from 'vitest';
import type { RigFeedItem } from '@shared/rig/feed';
import { age, firstNames, personFor, refsToTokens, splitAction, toFeedItem, toFeedItems } from './real-feed';

const NOW = Date.parse('2026-10-20T19:00:00Z');

const item = (id: string, d: 'ask_you' | 'do_it' | 'bring_in', card = true): RigFeedItem => ({
  situationId: id,
  sources: ['slack', 'linear'],
  bindingId: null,
  title: `Situation ${id}`,
  description: `About ${id} [item:ULY-1].`,
  participants: ['Riyad Hasanov'],
  decision: { do: d, conf: 0.8, who: 'Dylan', look: 'next_event', trigger: 'new event' },
  card: card
    ? {
        title: `Card ${id}`,
        why: 'Riyad asked [ev:i04] about the registry [item:ULY-229].',
        action: '**Reply to Riyad.** Answer the vendor question.',
        choices: [],
        people: [],
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

  it('puts asks first, keeps Rig ids, and holds back a card not drafted yet', () => {
    const items = toFeedItems(
      { me: null, visible: [item('a', 'do_it'), item('b', 'ask_you', false), item('c', 'bring_in')], queued: [], following: [], snoozed: [], digest: [] },
      NOW
    );
    expect(items.map((i) => [i.id, i.group, i.choices[0]!.verb])).toEqual([
      // Bringing people in isn't built yet: a bring-in card is offered as a reply.
      ['sit:c', 'needs_you', 'reply'],
      ['sit:a', 'up_next', 'start'],
    ]);
    expect(items[0]!.situationId).toBe('c');
    expect(items[1]!.age).toBe('30m');
  });

  it('falls back to the situation for a single card with no draft', () => {
    const card = toFeedItem(item('b', 'ask_you', false), NOW);
    expect(card.title).toBe('Situation b');
    expect(card.why).toBe('About b {ULY-1}.');
  });

  it('says how old a card is', () => {
    expect(age('2026-10-20T18:59:30Z', NOW)).toBe('new');
    expect(age('2026-10-19T19:00:00Z', NOW)).toBe('1d');
  });
});

describe('drafted cards look like the prototype', () => {
  it("carry the drafted choices, the people as faces and tokens, and the source's logo", () => {
    const x: RigFeedItem = {
      ...item('d', 'ask_you'),
      card: {
        title: 'Pick the vendor list',
        why: '{@Riyad Hasanov} is blocked on the registry [item:ULY-229].',
        action: '**Answer {@Riyad Hasanov}**: pick 11 or 8.',
        choices: [
          { verb: 'reply', label: 'Pick the 8', lead: 'Go with the 8 vendors', tail: ': Rig tells {@Riyad Hasanov}.' },
          { verb: 'space', label: 'Ask Riyad', lead: 'Ask {@Riyad Hasanov} to decide', tail: 'in a new space' },
        ],
        people: ['Riyad Hasanov'],
        refsOk: true,
      },
    };
    const card = toFeedItem(x, NOW);
    // The bring-in choice isn't offered: it couldn't do what it says yet.
    expect(card.choices.map((c) => [c.verb, c.label, c.lead, c.tail])).toEqual([
      ['reply', 'Pick the 8', 'Go with the 8 vendors', ': Rig tells {@Riyad}.'],
    ]);
    expect(card.people).toEqual(['Riyad Hasanov']);
    expect(card.source).toMatchObject({ connector: 'linear' });
    expect(card.why).toBe('{@Riyad} is blocked on the registry {ULY-229}.');
    expect(card.tokenNotes).toEqual({ '@Riyad': 'Riyad Hasanov' });
    expect(firstNames(['Riyad Hasanov', 'Riyad Ali']).short('{@Riyad Ali} and {@Riyad Hasanov}')).toBe('{@Riyad Ali} and {@Riyad Hasanov}');
    expect(personFor('Riyad Hasanov')).toMatchObject({ name: 'Riyad Hasanov', hue: expect.any(Number) });
  });
});
