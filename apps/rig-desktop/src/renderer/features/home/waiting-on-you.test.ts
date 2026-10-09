import { describe, expect, it } from 'vitest';
import { row } from '@shared/rig/notification-fixture';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import {
  contextLine,
  deriveWaitingItems,
  doneLine,
  pendingRequestOf,
  usedInLabel,
  waitingAction,
  type WaitingItem,
} from './waiting-on-you';

const ME = 'u_me';
const spaces = [
  { bindingId: 'b_mkt', name: 'rig-marketing' },
  { bindingId: 'b_ops', name: 'rig-ops' },
];

describe('deriveWaitingItems', () => {
  it('only direct, unread things: your mentions and replies, invites, and your own agents waiting on you; newest first', () => {
    const status = new Map<string, RigSpaceStatus>([
      [
        'b_ops',
        {
          bindingId: 'b_ops',
          running: [
            { runId: 'r1', agent: 'claude', ownerUserId: ME, startedAt: '2026-10-08T12:00:00Z', activity: 'waiting', title: 'Run npm test' },
            { runId: 'r2', agent: 'codex', ownerUserId: 'u_hugo', startedAt: '2026-10-08T13:00:00Z', activity: 'waiting' },
            { runId: 'r3', agent: 'claude', ownerUserId: ME, startedAt: '2026-10-08T13:30:00Z', activity: 'editing' },
          ],
        },
      ],
    ]);
    const items = deriveWaitingItems({
      activity: [
        row({ id: '9', type: 'mention', tier: 'direct', bindingId: 'b_mkt', spaceName: 'rig-marketing', body: '@Dylan wdyt', createdAt: '2026-10-08T04:32:04Z', actor: { kind: 'user', userId: 'u_hugo', name: 'Hugo Renaudin', agent: null } }),
        row({ id: '8', type: 'reply', tier: 'direct', bindingId: 'b_mkt', createdAt: '2026-10-08T14:00:00Z', readAt: '2026-10-08T14:01:00Z' }),
        row({ id: '7', type: 'message', bindingId: 'b_mkt', createdAt: '2026-10-08T14:02:00Z' }),
        row({ id: '6', type: 'agent_waiting', tier: 'direct', bindingId: 'b_ops', createdAt: '2026-10-08T12:00:01Z' }),
        row({ id: '5', type: 'invite', tier: 'direct', bindingId: null, createdAt: '2026-10-08T11:00:00Z' }),
      ],
      invites: [{ id: 'inv1', bindingId: 'b_warm', rigName: 'warm-island', label: '#warm-island', inviterLabel: 'Ana', createdAt: '2026-10-08T10:00:00Z' }],
      spaces,
      statusByBinding: status,
      selfUserId: ME,
    });
    expect(items.map((i) => i.key)).toEqual(['r:r1', 'i:inv1', 'n:9']);
    expect(items[2]).toMatchObject({
      kind: 'reply',
      who: { userId: 'u_hugo', name: 'Hugo Renaudin' },
      verb: 'mentioned you',
      spaceName: 'rig-marketing',
      quote: '@Dylan wdyt',
    });
    expect(items[0]).toMatchObject({ kind: 'approval', agent: 'Claude', spaceName: 'rig-ops', title: 'Run npm test' });
  });

  it("names an agent's mention as its owner's agent", () => {
    const [item] = deriveWaitingItems({
      activity: [row({ type: 'mention', tier: 'direct', actor: { kind: 'agent', userId: 'u_hugo', name: 'Hugo', agent: 'claude' } })],
      invites: [],
      spaces,
      statusByBinding: new Map(),
      selfUserId: ME,
    });
    expect(item).toMatchObject({ who: { name: "Hugo's Claude", agent: 'claude', owner: 'Hugo' } });
  });

  it('nothing waiting: empty', () => {
    expect(deriveWaitingItems({ activity: null, invites: [], spaces, statusByBinding: new Map(), selfUserId: ME })).toEqual([]);
  });
});

describe('pendingRequestOf', () => {
  const requested = (seq: number, requestId: string, title: string) => ({
    seq,
    kind: 'permission_requested',
    payload: {
      requestId,
      toolCall: { toolCallId: `tc-${requestId}`, title },
      options: [
        { optionId: `${requestId}-no`, name: 'Reject', kind: 'reject_once' },
        { optionId: `${requestId}-yes`, name: 'Allow', kind: 'allow_once' },
      ],
    },
  });

  it('the newest request with no answer yet, with its options', () => {
    const events = [
      requested(1, 'q1', 'Read a file'),
      { seq: 2, kind: 'permission_decided', payload: { requestId: 'q1', optionId: 'q1-yes' } },
      requested(3, 'q2', 'Run npm test'),
    ];
    expect(pendingRequestOf(events)).toEqual({
      requestId: 'q2',
      title: 'Run npm test',
      options: [
        { optionId: 'q2-no', name: 'Reject', kind: 'reject_once' },
        { optionId: 'q2-yes', name: 'Allow', kind: 'allow_once' },
      ],
    });
  });

  it('none when every request is answered, or the run is not on this computer', () => {
    expect(
      pendingRequestOf([requested(1, 'q1', 'x'), { seq: 2, kind: 'permission_decided', payload: { requestId: 'q1' } }])
    ).toBeNull();
    expect(pendingRequestOf(null)).toBeNull();
  });
});

describe('waitingAction and doneLine', () => {
  const reply: WaitingItem = {
    kind: 'reply',
    key: 'n:1',
    notificationId: '1',
    bindingId: 'b',
    spaceName: 'rig-marketing',
    who: { userId: 'u', name: 'Hugo' },
    verb: 'mentioned you',
    quote: 'wdyt',
    messageId: 'm1',
    messageSeq: 5,
    path: null,
    at: '',
  };
  it('one action each: Reply, Open for a file comment, Accept, Approve, or Open when the run is not here', () => {
    expect(waitingAction(reply, { approvable: false })).toBe('Reply');
    expect(waitingAction({ ...reply, path: 'docs/plan.md' }, { approvable: false })).toBe('Open');
    const invite: WaitingItem = { kind: 'invite', key: 'i', inviteId: 'i', bindingId: 'b', spaceName: 'x', label: '#x', who: { userId: null, name: 'Ana' }, at: '' };
    expect(waitingAction(invite, { approvable: false })).toBe('Accept');
    const approval: WaitingItem = { kind: 'approval', key: 'r', runId: 'r', bindingId: 'b', spaceName: 'rig-ops', agent: 'Claude', agentKind: 'claude', title: null, at: '' };
    expect(waitingAction(approval, { approvable: true })).toBe('Approve');
    expect(waitingAction(approval, { approvable: false })).toBe('Open');
    expect(doneLine(reply)).toBe('Replied in #rig-marketing.');
    expect(doneLine(invite)).toBe('You joined #x.');
    expect(doneLine(approval)).toBe('Approved. Claude is back at work in #rig-ops.');
  });
});

describe('expired connectors', () => {
  it('waits on you only where a space uses it, after everything with a time, with Reconnect', () => {
    const items = deriveWaitingItems({
      activity: [row({ id: '9', type: 'mention', tier: 'direct', bindingId: 'b_mkt', createdAt: '2026-10-08T09:00:00Z' })],
      invites: [],
      spaces,
      statusByBinding: new Map(),
      selfUserId: ME,
      connectors: [
        { connectorId: 'linear', name: 'Linear', brand: '#5E6AD2', spaces: [{ bindingId: 'b_ops', name: 'rig-ops' }] },
        { connectorId: 'notion', name: 'Notion', brand: '#000', spaces: [] },
      ],
    });
    expect(items.map((i) => i.key)).toEqual(['n:9', 'c:linear']);
    const connector = items[1]!;
    expect(connector).toMatchObject({ kind: 'connector', bindingId: 'b_ops', spaceName: 'rig-ops', name: 'Linear' });
    expect(waitingAction(connector, { approvable: false })).toBe('Reconnect');
    expect(doneLine(connector)).toBe("You're signed in to Linear again.");
  });

  it('names where it is used', () => {
    expect(usedInLabel([{ name: 'a' }])).toBe('#a');
    expect(usedInLabel([{ name: 'a' }, { name: 'b' }])).toBe('#a and #b');
    expect(usedInLabel([{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toBe('3 spaces');
  });
});

describe('contextLine', () => {
  it('names who wrote the message before, with a short excerpt', () => {
    expect(contextLine({ authorName: 'Hugo Renaudin', body: '@claude looks like:\n- a mandatory onboarding call' })).toBe(
      'Hugo: @claude looks like: a mandatory onboarding call'
    );
    expect(contextLine({ authorName: 'Ana', body: '1. first\n2. second\n* third' })).toBe('Ana: first, second, third');
    expect(contextLine({ authorName: null, body: 'x'.repeat(200) })).toMatch(/^Someone: x{139}…$/);
    expect(contextLine(null)).toBeNull();
    expect(contextLine({ authorName: 'Hugo', body: '  ' })).toBeNull();
  });
});
