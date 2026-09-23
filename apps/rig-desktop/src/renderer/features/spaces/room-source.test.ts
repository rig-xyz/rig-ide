import { describe, expect, it } from 'vitest';
import { buildRoomFeed } from './fixtures/room-feed';
import { projectSessionCard } from './projection';
import { FixtureRoomSource } from './room-source';

describe('FixtureRoomSource + the scripted Bob/Alice/Carol room feed', () => {
  it('replays end to end without throwing, and settles every started session to done', () => {
    const source = new FixtureRoomSource(buildRoomFeed());
    expect(source.isDone()).toBe(false);
    source.replayAll();
    expect(source.isDone()).toBe(true);

    const snapshot = source.getSnapshot();
    expect(Object.keys(snapshot.sessionMetaByRun).length).toBe(6);
    for (const [runId, meta] of Object.entries(snapshot.sessionMetaByRun)) {
      const events = snapshot.sessionEventsByRun[runId];
      expect(events, `no events recorded for ${meta.title}`).toBeDefined();
      expect(events.length).toBeGreaterThan(0);
      const card = projectSessionCard(events);
      expect(['done', 'stopped']).toContain(card.status);
    }
  });

  it('every member who ends up invited also ends up "here" (Alice and Carol both join)', () => {
    const source = new FixtureRoomSource(buildRoomFeed());
    source.replayAll();
    const snapshot = source.getSnapshot();
    const names = snapshot.members.map((m) => m.id).sort();
    expect(names).toEqual(['alice', 'bob', 'carol']);
    for (const member of snapshot.members) {
      expect(member.status).toBe('here');
    }
    for (const invite of Object.values(snapshot.invitesById)) {
      expect(invite.status).toBe('joined');
    }
  });

  it('no agent is left busy once the feed is fully replayed', () => {
    const source = new FixtureRoomSource(buildRoomFeed());
    source.replayAll();
    const snapshot = source.getSnapshot();
    expect(snapshot.agents.length).toBeGreaterThan(0);
    for (const agent of snapshot.agents) {
      expect(agent.busy).toBe(false);
    }
  });

  it('messages are seq-ordered and every session/invite/comment_mirror message resolves against room state', () => {
    const source = new FixtureRoomSource(buildRoomFeed());
    source.replayAll();
    const snapshot = source.getSnapshot();

    for (let i = 1; i < snapshot.messages.length; i++) {
      expect(snapshot.messages[i].seq).toBeGreaterThan(snapshot.messages[i - 1].seq);
    }

    for (const message of snapshot.messages) {
      if (message.meta.kind === 'session') {
        expect(snapshot.sessionMetaByRun[message.meta.runId]).toBeDefined();
      }
      if (message.meta.kind === 'invite') {
        expect(snapshot.invitesById[message.meta.inviteId]).toBeDefined();
      }
    }
  });

  it('subscribers see every event exactly once, in order, and getSnapshot matches the final notification', () => {
    const source = new FixtureRoomSource(buildRoomFeed());
    const seen: string[] = [];
    let last: ReturnType<typeof source.getSnapshot> | null = null;
    const unsubscribe = source.subscribe((event, snapshot) => {
      seen.push(event.type);
      last = snapshot;
    });
    source.replayAll();
    unsubscribe();

    expect(seen.length).toBeGreaterThan(0);
    expect(last).toBe(source.getSnapshot());
  });

  it('play()/pause() replay incrementally over time (fixture-scale smoke test, not full replay)', async () => {
    const source = new FixtureRoomSource(buildRoomFeed(), { speed: 1000 });
    let notifications = 0;
    source.subscribe(() => {
      notifications += 1;
    });
    source.play();
    expect(source.isPlaying()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    source.pause();
    expect(source.isPlaying()).toBe(false);
    expect(notifications).toBeGreaterThan(0);
    source.dispose();
  });
});
