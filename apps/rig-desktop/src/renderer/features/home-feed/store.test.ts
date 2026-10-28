import { describe, expect, it } from 'vitest';
import { ARRIVAL } from './mock';
import type { RailSession, RailSpace } from './model';
import { feedCounts, findSession, homeReducer, initialHomeState } from './store';

describe('homeReducer', () => {
  it('starts with two items that need you and four up next', () => {
    expect(feedCounts(initialHomeState().feed)).toEqual({ needsYou: 2, upNext: 4 });
  });

  it('picking a choice throws away an edit and slides the text in', () => {
    let s = initialHomeState();
    s = homeReducer(s, { type: 'edit', itemId: 'ask_429', text: 'My own words' });
    s = homeReducer(s, { type: 'pick', itemId: 'ask_429', choiceId: 'block', slide: 'left' });
    const e = s.feed.find((x) => x.item.id === 'ask_429')!;
    expect(e).toMatchObject({ pick: 'block', edited: null, slide: 'left', resetKey: 1 });
  });

  it("a redrafted card drops a pick or edit made on its old choices; an unchanged one keeps them", () => {
    let s = initialHomeState();
    s = homeReducer(s, { type: 'pick', itemId: 'ask_429', choiceId: 'block', slide: 'left' });
    s = homeReducer(s, { type: 'edit', itemId: 'ask_429', text: 'My own words' });
    s = homeReducer(s, { type: 'edit-draft', itemId: 'ask_429', text: 'My own draft' });
    const items = s.feed.map((e) => e.item);
    // Read again, the same choices: the person's pick and words stay.
    const same = homeReducer(s, { type: 'replace-feed', items: items.map((i) => ({ ...i })) });
    expect(same.feed.find((x) => x.item.id === 'ask_429')).toMatchObject({ pick: 'block', edited: 'My own words', draftEdit: 'My own draft' });
    // Rig redrafted it: choice ids are positions, so the old pick would land on another answer.
    const redrafted = items.map((i) =>
      i.id === 'ask_429' ? { ...i, choices: i.choices.map((c, n) => (n === 0 ? { ...c, lead: 'Something else now' } : c)) } : i
    );
    const was = s.feed.find((x) => x.item.id === 'ask_429')!;
    const e = homeReducer(s, { type: 'replace-feed', items: redrafted }).feed.find((x) => x.item.id === 'ask_429')!;
    expect(e).toMatchObject({ pick: undefined, edited: null, draftEdit: null, resetKey: was.resetKey + 1 });
  });

  it('an ignored item stays as a slim row, out of the counts, until it is removed', () => {
    let s = initialHomeState();
    s = homeReducer(s, { type: 'ignore', itemId: 'prp_hugo', value: true });
    expect(feedCounts(s.feed).upNext).toBe(3);
    expect(s.feed.some((e) => e.item.id === 'prp_hugo')).toBe(true);
    s = homeReducer(s, { type: 'remove', itemId: 'prp_hugo' });
    expect(s.feed.some((e) => e.item.id === 'prp_hugo')).toBe(false);
  });

  it('a promoted item leads its group and arrives fresh', () => {
    let s = initialHomeState();
    s = homeReducer(s, { type: 'add-item', item: ARRIVAL.item() });
    const firstNext = s.feed.find((e) => e.item.group === 'up_next')!;
    expect(firstNext.item.id).toBe('prp_claims');
    expect(firstNext.fresh).toBe(true);
    expect(homeReducer(s, { type: 'add-item', item: ARRIVAL.item() }).feed).toHaveLength(
      s.feed.length
    );
  });

  it('a new session waits invisible in the rail until its copy lands', () => {
    const session: RailSession = {
      id: 's-new1',
      spaceId: 'rig-ops',
      name: 'New',
      state: 'starting',
      short: 'Starting',
      summary: '',
      last: { who: 'Claude', text: '', ago: 'now' },
      steps: [],
      origin: 'mock',
      fresh: true,
    };
    let s = homeReducer(initialHomeState(), { type: 'add-session', spaceId: 'rig-ops', session });
    expect(findSession(s.demo, 's-new1')?.session.fresh).toBe(true);
    s = homeReducer(s, { type: 'land', id: 's-new1' });
    expect(findSession(s.demo, 's-new1')?.session.fresh).toBe(false);
    expect(s.landed).toEqual({ id: 's-new1', n: 1 });
  });

  it('bringing someone in moves the session into a new shared space, history and all', () => {
    const space: RailSpace = {
      id: 'urgent-triage',
      name: 'urgent-triage',
      visibility: 'shared',
      faces: [],
      unread: 0,
      summary: '',
      sessions: [],
      origin: 'mock',
      fresh: true,
    };
    const s = homeReducer(initialHomeState(), {
      type: 'move-session',
      sessionId: 's-triage',
      space,
      patch: { state: 'waiting_on_person' },
      steps: ['Moved', 'Waiting for Riyad'],
    });
    expect(s.demo[0]!.sessions.some((x) => x.id === 's-triage')).toBe(false);
    expect(s.demo[1]!.id).toBe('urgent-triage');
    const moved = s.demo[1]!.sessions[0]!;
    expect(moved).toMatchObject({
      id: 's-triage',
      spaceId: 'urgent-triage',
      state: 'waiting_on_person',
    });
    expect(moved.steps.at(-1)).toEqual({ text: 'Waiting for Riyad', ago: 'now' });
    expect(moved.steps).toHaveLength(7);
  });

  it('an update can add a step, and only the newest step keeps its time', () => {
    const s = homeReducer(initialHomeState(), {
      type: 'update-session',
      id: 's-triage',
      patch: { state: 'running', activity: 'editing' },
      step: 'You: block it',
    });
    const triage = findSession(s.demo, 's-triage')!.session;
    expect(triage.state).toBe('running');
    expect(triage.steps.filter((x) => x.ago)).toEqual([{ text: 'You: block it', ago: 'now' }]);
  });
});

describe('replace-feed', () => {
  it("replaces the demo Feed with the orchestrator's, keeping a card's local state", () => {
    const start = initialHomeState();
    const real = { ...start.feed[0]!.item, id: 'sit:s1', situationId: 's1', title: 'Real' };
    let state = homeReducer(start, { type: 'replace-feed', items: [real] });
    expect(state.feed.map((e) => e.item.id)).toEqual(['sit:s1']);
    state = homeReducer(state, { type: 'edit', itemId: 'sit:s1', text: 'my words' });
    state = homeReducer(state, {
      type: 'replace-feed',
      items: [{ ...real, title: 'Real, updated' }],
    });
    expect(state.feed[0]!.item.title).toBe('Real, updated');
    expect(state.feed[0]!.edited).toBe('my words');
  });
});
