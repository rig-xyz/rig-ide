import { afterEach, describe, expect, it } from 'vitest';
import type { RigChatStore } from '@renderer/features/chat/rig-chat-store';
import {
  __resetSessionAttentionForTests,
  noteSessionOutput,
  noteSessionSeen,
} from '@renderer/features/chat/session-attention-store';
import type { RigStoredSession } from '@shared/rig/sessions';
import { mySessionOf } from './my-sessions-model';

const stored: RigStoredSession = {
  id: 'ses-1',
  rigId: 'rig-1',
  providerId: 'claude',
  title: 'Answer Natalie on AI pulse checks',
  titleSource: 'manual',
  status: 'active',
  createdAt: 1_000,
  updatedAt: 2_000,
  acpSessionId: 'acp-1',
};

function live(over: Partial<{ title: string | null; isWorking: boolean; queue: unknown[] }> = {}): RigChatStore {
  return {
    title: over.title ?? null,
    createdAt: 5_000,
    permissionQueue: over.queue ?? [],
    resolvingPermissionOptionId: null,
    affordances: { isWorking: over.isWorking ?? false, canSubmit: true, canCancel: false },
  } as unknown as RigChatStore;
}

afterEach(() => __resetSessionAttentionForTests());

describe('mySessionOf', () => {
  it('is idle, in the list only, when it does not run in this window', () => {
    expect(mySessionOf(stored, null)).toMatchObject({ state: 'idle', title: stored.title, at: 2_000 });
  });

  it('waits on you with the approval it asks for', () => {
    const request = { requestId: 'r1', title: 'Write drafts/alpha.md', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] };
    expect(mySessionOf(stored, live({ queue: [request], isWorking: true }))).toMatchObject({
      state: 'waiting',
      approval: { title: 'Write drafts/alpha.md', options: request.options, resolvingOptionId: null },
      at: 5_000,
    });
  });

  it('is working while its turn runs, under the live title', () => {
    expect(mySessionOf(stored, live({ isWorking: true, title: 'Pulse questions' }))).toMatchObject({
      state: 'working',
      title: 'Pulse questions',
    });
  });

  it('is done until its new output is seen, then idle', () => {
    noteSessionOutput('ses-1', 10_000);
    expect(mySessionOf(stored, live()).state).toBe('done');
    noteSessionSeen('ses-1', 11_000);
    expect(mySessionOf(stored, live()).state).toBe('idle');
  });

  it('falls back to "Untitled session" with no title anywhere', () => {
    expect(mySessionOf({ ...stored, title: null }, null).title).toBe('Untitled session');
  });
});
