import { describe, expect, it } from 'vitest';
import { row } from '@shared/rig/notification-fixture';
import { bellPlace, leftOutLine, shapeBell } from './bell-model';

const ME = 'u_me';
const ctx = { selfUserId: ME, awayIds: new Set<string>() };

describe('bellPlace', () => {
  it('keeps what is for you: mentions, replies, invites, approvals and requests', () => {
    for (const type of ['mention', 'reply', 'invite', 'agent_waiting', 'agent_request'] as const) {
      expect(bellPlace(row({ type, tier: 'direct' }), ctx)).toBe('keep');
    }
  });

  it('leaves out room messages and reactions', () => {
    expect(bellPlace(row({ type: 'message' }), ctx)).toBe('messages');
    expect(bellPlace(row({ type: 'reaction', tier: 'direct' }), ctx)).toBe('reactions');
  });

  it('keeps a comment on your own file, or through your link; not one on somebody else’s, or an unknown one', () => {
    expect(bellPlace(row({ type: 'comment', fileAuthorUserId: ME }), ctx)).toBe('keep');
    expect(bellPlace(row({ type: 'comment', tier: 'direct' }), ctx)).toBe('keep');
    expect(bellPlace(row({ type: 'comment', fileAuthorUserId: 'u_hugo' }), ctx)).toBe('comments');
    expect(bellPlace(row({ type: 'comment' }), ctx)).toBe('comments');
  });

  it("keeps someone else's agent finishing work you asked for; yours only when it finished while you were away", () => {
    const theirs = row({ id: '1', type: 'agent_finished', tier: 'direct', actor: { kind: 'agent', userId: 'u_hugo', name: 'Hugo', agent: 'claude' } });
    const mine = row({ id: '2', type: 'agent_finished', tier: 'direct', actor: { kind: 'agent', userId: ME, name: 'Dylan', agent: 'claude' } });
    expect(bellPlace(theirs, ctx)).toBe('keep');
    expect(bellPlace(mine, ctx)).toBe('ownAgents');
    expect(bellPlace(mine, { ...ctx, awayIds: new Set(['2']) })).toBe('keep');
  });
});

describe('shapeBell', () => {
  it('groups what it keeps by space, newest space first, and counts the unread it keeps', () => {
    const model = shapeBell(
      [
        row({ id: '9', type: 'mention', tier: 'direct', bindingId: 'b_mkt', spaceName: 'rig-marketing' }),
        row({ id: '8', type: 'message', bindingId: 'b_mkt' }),
        row({ id: '7', type: 'mention', tier: 'direct', bindingId: 'b_fkn', spaceName: 'rig-fkn-sht', readAt: '2026-10-07T00:00:00Z' }),
        row({ id: '6', type: 'reply', tier: 'direct', bindingId: 'b_mkt', spaceName: 'rig-marketing' }),
        row({ id: '5', type: 'invite', tier: 'direct', bindingId: null, spaceName: 'warm-island' }),
      ],
      ctx
    );
    expect(model.groups.map((g) => [g.spaceName, g.rows.map((r) => r.id)])).toEqual([
      ['rig-marketing', ['9', '6']],
      ['rig-fkn-sht', ['7']],
      ['warm-island', ['5']],
    ]);
    expect(model.unread).toBe(3);
    expect(model.leftOut).toEqual({ ownAgents: 0, messages: 1, comments: 0, reactions: 0 });
  });
});

describe('leftOutLine', () => {
  it('says how many were left out and why, in plain words', () => {
    expect(leftOutLine({ ownAgents: 8, messages: 36, comments: 4, reactions: 0 })).toBe(
      "48 more are left out: 8 runs of your own agents finishing while you were here, 36 room messages and 4 comments on files that aren't yours. They stay in each space."
    );
    expect(leftOutLine({ ownAgents: 0, messages: 1, comments: 0, reactions: 0 })).toBe(
      '1 more is left out: 1 room message. They stay in each space.'
    );
    expect(leftOutLine({ ownAgents: 0, messages: 0, comments: 0, reactions: 0 })).toBeNull();
  });
});
