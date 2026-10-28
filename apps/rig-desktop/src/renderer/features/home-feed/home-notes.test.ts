import { observable, runInAction } from 'mobx';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RigChatStore } from '@renderer/features/chat/rig-chat-store';
import type { RigSessionStart } from '@shared/rig/feed';
import { homeNotes as read, noteSessionStart, noteWords, resetHomeNotes, type HomeNote } from './home-notes';

/** A live session as the window holds it: whether it works, and what it asks. */
function session(id: string) {
  return observable({
    conversationId: id,
    disposed: false,
    permissionQueue: [] as unknown[],
    affordances: { isWorking: false },
  });
}
const start = (over: Partial<RigSessionStart> = {}): RigSessionStart => ({
  sessionId: 'ses_1',
  continue: false,
  bindingId: 'b_home',
  root: '/Rig/home',
  prompt: 'Work through sessions/x/brief.md',
  title: 'Fix the payout retry',
  situationId: 'sit_1',
  ...over,
});
const words = (n: HomeNote) => `${noteWords(n).before}${n.title}${noteWords(n).after}`;

beforeEach(() => resetHomeNotes());

describe("Rig's notes in Home", () => {
  it('says it started, then that it is done once the session has worked and stopped', () => {
    const s = session('ses_1');
    noteSessionStart(start(), s as unknown as RigChatStore);
    runInAction(() => (s.affordances.isWorking = true));
    runInAction(() => (s.affordances.isWorking = false));
    expect(read().map(words)).toEqual([
      "Started working on Fix the payout retry. I'll let you know when it's done.",
      'Done: Fix the payout retry.',
    ]);
    expect(read()[1]).toMatchObject({ kind: 'done', root: '/Rig/home', sessionId: 'ses_1' });
  });

  it('a session that stops to ask is ready for review; so is a Reply that drafts and asks first', () => {
    const asking = session('ses_2');
    noteSessionStart(start({ title: 'Merge the pricing PR' }), asking as unknown as RigChatStore);
    runInAction(() => (asking.affordances.isWorking = true));
    runInAction(() => asking.permissionQueue.push({}));
    const reply = session('ses_3');
    noteSessionStart(start({ title: 'Reply to Priya', askFirst: true }), reply as unknown as RigChatStore);
    runInAction(() => (reply.affordances.isWorking = true));
    runInAction(() => (reply.affordances.isWorking = false));
    expect(read().filter((n) => n.kind === 'review').map(words)).toEqual([
      'Merge the pricing PR is ready for review.',
      'Reply to Priya is ready for review.',
    ]);
  });

  it('says nothing more for a session that never worked, or one started again', () => {
    const s = session('ses_4');
    noteSessionStart(start(), s as unknown as RigChatStore);
    noteSessionStart(start(), s as unknown as RigChatStore);
    runInAction(() => (s.affordances.isWorking = true));
    runInAction(() => (s.affordances.isWorking = false));
    // Two starts said, one done: the first start's follower let go.
    expect(read().map((n) => n.kind)).toEqual(['started', 'started', 'done']);
  });
});
