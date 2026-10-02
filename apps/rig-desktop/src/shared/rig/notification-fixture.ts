import type { RigNotification } from './notifications';

/** Test fixture: one notification row, as the relay returns it. */

export const NOW = Date.parse('2026-10-01T12:00:00Z');

export function row(overrides: Partial<RigNotification> = {}): RigNotification {
  return {
    id: '1',
    type: 'message',
    tier: 'ambient',
    bindingId: 'bnd_a',
    spaceName: 'Launch',
    actor: { kind: 'user', userId: 'u_hugo', name: 'Hugo', agent: null },
    messageId: 'msg_1',
    messageSeq: 10,
    runId: null,
    requestId: null,
    inviteId: null,
    path: null,
    title: 'Hugo in Launch',
    body: 'hello',
    createdAt: new Date(NOW - 1000).toISOString(),
    readAt: null,
    ...overrides,
  };
}
