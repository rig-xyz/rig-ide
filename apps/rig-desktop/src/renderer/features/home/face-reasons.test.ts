import { describe, expect, it } from 'vitest';
import type { RigNotification } from '@shared/rig/notifications';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import {
  deriveFaceReasons,
  faceReasonLabel,
  topicFaceReasons,
  unreadMentionsBySpace,
  type FaceReason,
} from './face-reasons';

const ME = 'u-me';
const members = [
  { userId: 'u-hugo', name: 'Hugo Renaudin', avatarUrl: 'hugo.png' },
  { userId: 'u-ana', name: 'Ana Silva', avatarUrl: null },
  { userId: 'u-raf', name: 'Rafael Keramati', avatarUrl: null },
  { userId: ME, name: 'Dylan Bourgeois', avatarUrl: null },
];

function note(over: Partial<RigNotification> = {}): RigNotification {
  return {
    id: 'n1',
    type: 'mention',
    tier: 'direct',
    bindingId: 'b1',
    spaceName: 'rig-marketing',
    actor: { kind: 'user', userId: 'u-hugo', name: 'Hugo Renaudin', agent: null },
    messageId: 'm1',
    messageSeq: 10,
    runId: null,
    requestId: null,
    inviteId: null,
    path: null,
    title: 'Hugo Renaudin mentioned you in rig-marketing',
    body: '@Dylan wdyt',
    createdAt: '2026-10-08T04:32:04Z',
    readAt: null,
    ...over,
  };
}

const msg = (seq: number, authorUserId: string, authorKind: 'user' | 'agent' | 'guest' = 'user') => ({
  id: `m${seq}`,
  seq,
  createdAt: '2026-10-08T04:00:00Z',
  authorUserId,
  authorKind,
});

describe('deriveFaceReasons', () => {
  it('nobody is a reason in a quiet space: no faces', () => {
    const status: RigSpaceStatus = { bindingId: 'b1', running: [], recentMessages: [msg(4, 'u-hugo')] };
    expect(deriveFaceReasons({ selfUserId: ME, mentions: [], status, cursor: 10, members })).toEqual([]);
  });

  it('who mentioned you, then who left unread messages, then whose agent is running; each once, never you', () => {
    const status: RigSpaceStatus = {
      bindingId: 'b1',
      running: [
        { runId: 'r1', agent: 'claude', ownerUserId: 'u-raf', startedAt: '', activity: 'editing' },
        { runId: 'r2', agent: 'claude', ownerUserId: ME, startedAt: '', activity: 'editing' },
      ],
      recentMessages: [msg(9, 'u-ana'), msg(11, 'u-hugo'), msg(12, 'u-ana', 'agent'), msg(13, ME)],
    };
    const faces = deriveFaceReasons({ selfUserId: ME, mentions: [note()], status, cursor: 10, members });
    expect(faces.map((f) => [f.userId, f.kind])).toEqual([
      ['u-hugo', 'mentioned'],
      ['u-ana', 'unread'],
      ['u-raf', 'running'],
    ]);
    expect(faces[0]).toMatchObject({ name: 'Hugo Renaudin', avatarUrl: 'hugo.png' });
  });

  it("a guest's comment is stamped with the link's creator, so it never puts that face up", () => {
    const status: RigSpaceStatus = { bindingId: 'b1', running: [], recentMessages: [msg(11, 'u-hugo', 'guest')] };
    expect(deriveFaceReasons({ selfUserId: ME, mentions: [], status, cursor: 10, members })).toEqual([]);
  });

  it('a relay that sends no message authors, or no cursor: only the person who mentioned you', () => {
    const status: RigSpaceStatus = { bindingId: 'b1', running: [] };
    expect(
      deriveFaceReasons({ selfUserId: ME, mentions: [note()], status, cursor: 10, members }).map((f) => f.userId)
    ).toEqual(['u-hugo']);
    const withMessages: RigSpaceStatus = { bindingId: 'b1', running: [], recentMessages: [msg(11, 'u-ana')] };
    expect(
      deriveFaceReasons({ selfUserId: ME, mentions: [note()], status: withMessages, cursor: null, members }).map(
        (f) => f.userId
      )
    ).toEqual(['u-hugo']);
  });

  it('falls back to what the row says when the member list has no one by that id', () => {
    const faces = deriveFaceReasons({ selfUserId: ME, mentions: [note()], status: undefined, cursor: null, members: [] });
    expect(faces).toEqual([{ userId: 'u-hugo', name: 'Hugo Renaudin', avatarUrl: null, kind: 'mentioned' }]);
  });
});

describe('unreadMentionsBySpace', () => {
  it('keeps unread mentions and replies, by space', () => {
    const rows = [
      note({ id: '1' }),
      note({ id: '2', type: 'reply', bindingId: 'b2' }),
      note({ id: '3', readAt: '2026-10-08T05:00:00Z' }),
      note({ id: '4', type: 'message', tier: 'ambient' }),
      note({ id: '5', type: 'invite', bindingId: null }),
    ];
    const by = unreadMentionsBySpace(rows);
    expect([...by].map(([b, list]) => [b, list.map((r) => r.id)])).toEqual([
      ['b1', ['1']],
      ['b2', ['2']],
    ]);
  });
});

describe('topicFaceReasons', () => {
  const reasons: FaceReason[] = [
    { userId: 'u-hugo', name: 'Hugo Renaudin', avatarUrl: null, kind: 'mentioned' },
    { userId: 'u-raf', name: 'Rafael Keramati', avatarUrl: null, kind: 'running' },
  ];

  it('only the people the topic names who are a reason; an agent counts as its owner', () => {
    expect(topicFaceReasons(["Hugo's Claude", 'Ana', 'Rafael'], reasons, { kind: 'new', count: 3 }).map((f) => f.name)).toEqual([
      'Hugo',
      'Rafael',
    ]);
  });

  it('a topic already read keeps only running agents', () => {
    expect(topicFaceReasons(['Hugo', 'Rafael'], reasons, { kind: 'seen' }).map((f) => f.name)).toEqual(['Rafael']);
  });

  it('no reasons, no faces', () => {
    expect(topicFaceReasons(['Hugo', 'Ana'], [], undefined)).toEqual([]);
  });
});

describe('faceReasonLabel', () => {
  it('says why the face is there, in plain words', () => {
    expect(faceReasonLabel({ name: 'Hugo Renaudin', kind: 'mentioned' })).toBe('Hugo Renaudin mentioned you');
    expect(faceReasonLabel({ name: 'Ana Silva', kind: 'unread' })).toBe('New messages from Ana Silva');
    expect(faceReasonLabel({ name: 'Rafael', kind: 'running' })).toBe("Rafael's agent is working here");
    expect(faceReasonLabel({ name: null, kind: 'mentioned' })).toBe('Someone mentioned you');
  });
});
