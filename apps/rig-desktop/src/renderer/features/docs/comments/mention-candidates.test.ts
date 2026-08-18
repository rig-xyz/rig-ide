import { describe, expect, it } from 'vitest';
import {
  findMention,
  mentionCandidateKey,
  mentionCandidateLabel,
  mentionCandidateMatches,
  mentionInsertText,
  type MentionCandidate,
} from './mention-candidates';

/**
 * The agent-vs-person classification behind the unified `@mention` menu.
 * `findMention` (comment reply/create dispatch) and `mentionInsertText`
 * (menu selection → composer text) never share code — these tests exist to
 * prove that separation holds, not just describe it.
 */

const AGENTS = [
  { providerId: 'claude', name: 'Claude' },
  { providerId: 'codex', name: 'Codex' },
];

function agentCandidate(providerId: string, name: string): MentionCandidate {
  return { kind: 'agent', agent: { providerId, name } };
}

function personCandidate(userId: string, name: string | null): MentionCandidate {
  return { kind: 'person', person: { userId, name, avatarUrl: null } };
}

describe('mentionCandidateLabel / mentionCandidateKey', () => {
  it('reads an agent candidate off its name and provider id', () => {
    const candidate = agentCandidate('claude', 'Claude');
    expect(mentionCandidateLabel(candidate)).toBe('Claude');
    expect(mentionCandidateKey(candidate)).toBe('claude');
  });

  it('reads a person candidate off its name and user id, falling back when unnamed', () => {
    const named = personCandidate('usr_1', 'Dylan Bourgeois');
    expect(mentionCandidateLabel(named)).toBe('Dylan Bourgeois');
    expect(mentionCandidateKey(named)).toBe('usr_1');

    const unnamed = personCandidate('usr_2', null);
    expect(mentionCandidateLabel(unnamed)).toBe('Unknown');
  });
});

describe('mentionCandidateMatches', () => {
  it('matches an agent by provider-id prefix or name substring', () => {
    const claude = agentCandidate('claude', 'Claude');
    expect(mentionCandidateMatches(claude, 'cla')).toBe(true);
    expect(mentionCandidateMatches(claude, 'aud')).toBe(true); // name substring
    expect(mentionCandidateMatches(claude, 'codex')).toBe(false);
  });

  it('matches a person by name substring, case-insensitively', () => {
    const dylan = personCandidate('usr_1', 'Dylan Bourgeois');
    expect(mentionCandidateMatches(dylan, 'dyl')).toBe(true);
    expect(mentionCandidateMatches(dylan, 'bourg')).toBe(true);
    expect(mentionCandidateMatches(dylan, 'zzz')).toBe(false);
  });
});

describe('mentionInsertText', () => {
  it('inserts @providerId for an agent', () => {
    expect(mentionInsertText(agentCandidate('claude', 'Claude'))).toBe('@claude ');
  });

  it('inserts @Full Name for a person', () => {
    expect(mentionInsertText(personCandidate('usr_1', 'Dylan Bourgeois'))).toBe(
      '@Dylan Bourgeois '
    );
  });

  it('never produces an agent-shaped provider-id token for a person', () => {
    // The actual safety property: a person candidate has no `providerId` to
    // draw from, so nothing here can ever equal what an agent would insert.
    const person = mentionInsertText(personCandidate('usr_1', 'Dylan Bourgeois'));
    for (const agent of AGENTS) {
      expect(person).not.toBe(`@${agent.providerId} `);
    }
  });
});

describe('findMention (dispatch decision) never fires on a person mention', () => {
  it('does not dispatch when the composed body only contains a person mention', () => {
    const text = `Hey ${mentionInsertText(personCandidate('usr_1', 'Dylan Bourgeois'))}can you take a look?`;
    expect(findMention(text, AGENTS)).toBeUndefined();
  });

  it('still dispatches when the body contains a real agent mention alongside one', () => {
    const text = `${mentionInsertText(personCandidate('usr_1', 'Dylan Bourgeois'))}@claude can you help too?`;
    expect(findMention(text, AGENTS)?.providerId).toBe('claude');
  });

  it(
    'known, accepted gap: a person whose name IS an agent provider id still dispatches — ' +
      'findMention has no way to tell the two apart from typed text alone',
    () => {
      const text = mentionInsertText(personCandidate('usr_1', 'Claude'));
      expect(findMention(text, AGENTS)?.providerId).toBe('claude');
    }
  );
});
