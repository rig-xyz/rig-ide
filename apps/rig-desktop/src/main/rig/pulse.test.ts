import { describe, expect, it } from 'vitest';
import { toAskAnswer, toPulseBriefing } from './pulse';

// Fixture shapes mirror `tap`'s real `packages/relay/src/pulse.ts` output —
// confirmed against a live prod `GET /v1/me/pulse` / `POST /v1/me/ask` call
// (round H3), not guessed. Values below are synthetic, not the real response.

describe('toPulseBriefing', () => {
  it('parses a full, non-degraded briefing', () => {
    const wire = {
      greeting: 'Good morning, Dylan.',
      summary: 'You have three open intents across two rigs.',
      pickBackUp: [
        {
          bindingId: 'bnd_1',
          rigName: 'rig-one',
          intentId: 'int_1',
          title: 'Fix the bug',
          why: 'Blocking the release.',
          at: '2026-08-15T10:00:00Z',
        },
      ],
      perRig: [
        { bindingId: 'bnd_1', rigName: 'rig-one', line: 'Shipped the bug fix.', at: '2026-08-15T10:00:00Z' },
      ],
      perPerson: [
        {
          userId: 'usr_1',
          name: 'Dylan',
          avatarUrl: 'https://example.com/a.png',
          line: "You've been heads-down on rig-one.",
          isSelf: true,
        },
      ],
      generatedAt: '2026-08-15T10:05:00Z',
      degraded: false,
    };

    expect(toPulseBriefing(wire)).toEqual(wire);
  });

  it('parses the "no rigs yet" empty briefing (empty arrays, not missing)', () => {
    const wire = {
      greeting: 'Good morning — no rigs yet. Create or join one to get started.',
      summary: '',
      pickBackUp: [],
      perRig: [],
      perPerson: [],
      generatedAt: '2026-08-15T10:05:00Z',
      degraded: false,
    };
    expect(toPulseBriefing(wire)).toEqual(wire);
  });

  it('degrades missing optional fields to their honest empty value rather than dropping the briefing', () => {
    expect(toPulseBriefing({ greeting: 'Hi' })).toEqual({
      greeting: 'Hi',
      summary: '',
      pickBackUp: [],
      perRig: [],
      perPerson: [],
      generatedAt: '',
      degraded: false,
    });
  });

  it('drops a malformed pickBackUp/perRig/perPerson entry rather than the whole briefing', () => {
    const result = toPulseBriefing({
      greeting: 'Hi',
      pickBackUp: [{ bindingId: 'bnd_1', intentId: 'int_1', title: 'ok' }, { title: 'missing ids' }, null],
      perRig: [{ bindingId: 'bnd_1' }, {}],
      perPerson: [{ userId: 'usr_1' }, {}],
    });
    expect(result?.pickBackUp).toHaveLength(1);
    expect(result?.perRig).toHaveLength(1);
    expect(result?.perPerson).toHaveLength(1);
  });

  it('rejects a payload with no greeting rather than fabricating one', () => {
    expect(toPulseBriefing({ summary: 'no greeting here' })).toBeNull();
    expect(toPulseBriefing(null)).toBeNull();
    expect(toPulseBriefing('not an object')).toBeNull();
  });

  it('preserves degraded: true — never silently upgrades a deterministic briefing to look narrated', () => {
    expect(toPulseBriefing({ greeting: 'Hi', degraded: true })?.degraded).toBe(true);
  });
});

describe('toAskAnswer', () => {
  it('parses a full answer with cited sources', () => {
    const wire = {
      answer: 'You should pick up the bug fix next.',
      sources: [{ kind: 'intent', bindingId: 'bnd_1', ref: 'int_1', label: 'Fix the bug' }],
    };
    expect(toAskAnswer(wire)).toEqual(wire);
  });

  it('drops a source with an unrecognized kind or missing ref, keeps the rest', () => {
    const result = toAskAnswer({
      answer: 'Answer text.',
      sources: [
        { kind: 'intent', bindingId: 'bnd_1', ref: 'int_1', label: 'ok' },
        { kind: 'not-a-real-kind', bindingId: 'bnd_1', ref: 'int_2', label: 'bad kind' },
        { kind: 'rig', bindingId: 'bnd_1', label: 'no ref' },
      ],
    });
    expect(result?.sources).toEqual([{ kind: 'intent', bindingId: 'bnd_1', ref: 'int_1', label: 'ok' }]);
  });

  it('falls back to ref as the label when the relay omits one', () => {
    const result = toAskAnswer({
      answer: 'Answer.',
      sources: [{ kind: 'rig', bindingId: 'bnd_1', ref: 'bnd_1' }],
    });
    expect(result?.sources[0]?.label).toBe('bnd_1');
  });

  it('an answer with no sources is still a valid answer', () => {
    expect(toAskAnswer({ answer: 'No sources for this one.', sources: [] })).toEqual({
      answer: 'No sources for this one.',
      sources: [],
    });
  });

  it('rejects a payload with no answer string rather than fabricating one', () => {
    expect(toAskAnswer({ sources: [] })).toBeNull();
    expect(toAskAnswer(null)).toBeNull();
  });
});
