import { makeObservable, observable, runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rigSessionRegistry } from './session/rig-session-registry';
import {
  __resetSessionAttentionForTests,
  getSessionAttentionFacts,
  noteSessionOutput,
  noteSessionSeen,
  subscribeSessionAttention,
} from './session-attention-store';

/** A minimal stand-in for `RigChatStore`: same `kind`/`affordances` shape the store reads, an observable `isWorking` so a test can flip it like the real MobX computed would change. */
class FakeLiveStore {
  readonly kind = 'live' as const;
  isWorking = false;

  constructor(readonly conversationId: string) {
    makeObservable(this, { isWorking: observable });
  }

  get affordances() {
    return { isWorking: this.isWorking, canSubmit: true, canCancel: false };
  }

  dispose(): void {}
}

afterEach(() => {
  __resetSessionAttentionForTests();
});

describe('getSessionAttentionFacts', () => {
  it('an untracked conversation reads as all-idle facts', () => {
    expect(getSessionAttentionFacts('untracked')).toEqual({
      isWorking: false,
      lastOutputAt: null,
      lastSeenAt: null,
    });
  });

  it('mirrors a live store\'s isWorking, reactively', () => {
    const store = rigSessionRegistry.attach('mirror-1', () => new FakeLiveStore('mirror-1'));
    expect(getSessionAttentionFacts('mirror-1').isWorking).toBe(false);

    runInAction(() => {
      store.isWorking = true;
    });
    expect(getSessionAttentionFacts('mirror-1').isWorking).toBe(true);

    runInAction(() => {
      store.isWorking = false;
    });
    expect(getSessionAttentionFacts('mirror-1').isWorking).toBe(false);
  });

  it('a replay (non-live) registry entry never reads as working', () => {
    rigSessionRegistry.attach('replay-1', () => ({
      conversationId: 'replay-1',
      kind: 'replay' as const,
      dispose: () => {},
    }));
    expect(getSessionAttentionFacts('replay-1').isWorking).toBe(false);
  });
});

describe('noteSessionOutput / noteSessionSeen', () => {
  it('records lastOutputAt without disturbing lastSeenAt', () => {
    noteSessionOutput('facts-1', 100);
    expect(getSessionAttentionFacts('facts-1')).toEqual({
      isWorking: false,
      lastOutputAt: 100,
      lastSeenAt: null,
    });
  });

  it('records lastSeenAt without disturbing lastOutputAt', () => {
    noteSessionOutput('facts-2', 100);
    noteSessionSeen('facts-2', 200);
    expect(getSessionAttentionFacts('facts-2')).toEqual({
      isWorking: false,
      lastOutputAt: 100,
      lastSeenAt: 200,
    });
  });
});

describe('subscribeSessionAttention', () => {
  it('notifies on noteSessionOutput/noteSessionSeen, not after unsubscribing', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionAttention('sub-1', listener);

    noteSessionOutput('sub-1');
    expect(listener).toHaveBeenCalledTimes(1);

    noteSessionSeen('sub-1');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    noteSessionOutput('sub-1');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies when a live store\'s isWorking flips, with no explicit note call', () => {
    const store = rigSessionRegistry.attach('sub-2', () => new FakeLiveStore('sub-2'));
    const listener = vi.fn();
    subscribeSessionAttention('sub-2', listener);

    runInAction(() => {
      store.isWorking = true;
    });
    expect(listener).toHaveBeenCalled();
  });
});
