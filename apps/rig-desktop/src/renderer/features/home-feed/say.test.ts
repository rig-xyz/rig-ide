import { describe, expect, it } from 'vitest';
import { demoFeed, demoSpaces } from './mock';
import { chosen, parseSay, plainSay, sayPlain, spaceLabel, stepChoice, tailSentence } from './say';

const feed = demoFeed();
const item = (id: string) => feed.find((i) => i.id === id)!;

describe('parseSay', () => {
  it('splits people, spaces, new spaces and refs out of the text', () => {
    expect(parseSay('Ask {@Riyad} to join a {new space} about {ULY-429} in {#rig-ops}.')).toEqual([
      { kind: 'text', text: 'Ask ' },
      { kind: 'token', token: 'person', text: '@Riyad' },
      { kind: 'text', text: ' to join a ' },
      { kind: 'token', token: 'new-space', text: 'new space' },
      { kind: 'text', text: ' about ' },
      { kind: 'token', token: 'ref', text: 'ULY-429' },
      { kind: 'text', text: ' in ' },
      { kind: 'token', token: 'space', text: '#rig-ops' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('unwraps tokens for the plain text', () => {
    expect(plainSay('Ask {@Riyad} about {ULY-429}')).toBe('Ask @Riyad about ULY-429');
  });
});

describe('the proposal for a choice', () => {
  it('starts with the action, then the context, then what the choice means', () => {
    const ask = item('ask_429');
    expect(sayPlain(ask, ask.choices[0]!)).toBe(
      'Ask @Riyad to decide. Claude found the causes of ULY-280 and ULY-220. ULY-429 needs a policy call: block A7A5 trading now, or wait. He owns account restrictions and joins a new space with this triage.'
    );
  });

  it('turns a trailing clause into its own sentence', () => {
    expect(tailSentence(': he owns it')).toBe('He owns it.');
    expect(tailSentence('.')).toBe('');
    expect(tailSentence(', each with a note.')).toBe('Each with a note.');
  });
});

describe('choices', () => {
  it('shows the first choice until one is picked, and steps around both ends', () => {
    const ask = item('ask_429');
    expect(chosen(ask, undefined).id).toBe('bring');
    expect(stepChoice(ask, undefined, -1).id).toBe('leave');
    expect(stepChoice(ask, 'leave', 1).id).toBe('bring');
  });

  it('names where it happens in one word, following the choice', () => {
    const spaces = demoSpaces();
    const ask = item('ask_429');
    expect(spaceLabel(ask, ask.choices[0]!, spaces)).toBe('New space');
    expect(spaceLabel(ask, ask.choices[1]!, spaces)).toBe('#ulys-backlog');
    const loyalty = item('prp_loyalty');
    expect(spaceLabel(loyalty, loyalty.choices[1]!, spaces)).toBe('#ulys-backlog');
  });

  it('only ever uses the four verbs', () => {
    const verbs = new Set(feed.flatMap((i) => i.choices.map((c) => c.verb)));
    expect([...verbs].every((v) => ['reply', 'start', 'space', 'open'].includes(v))).toBe(true);
  });
});
