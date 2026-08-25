import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeRestoredConversationIds } from '../../features/chat/session/restore-session-ids';
import {
  RigSessionRegistry,
  type RigSessionStore,
} from '../../features/chat/session/rig-session-registry';

type FakeStore = RigSessionStore & {
  dispose: ReturnType<typeof vi.fn>;
};

function fakeStore(
  conversationId: string,
  dispose: () => void | PromiseLike<void> = () => {}
): FakeStore {
  return {
    conversationId,
    dispose: vi.fn(dispose),
  };
}

describe('RigSessionRegistry', () => {
  let registry: RigSessionRegistry<FakeStore>;

  afterEach(() => {
    registry = new RigSessionRegistry<FakeStore>();
  });

  it('reuses a store by conversation id and detaches without disposing it', async () => {
    const first = fakeStore('conversation-1');
    const factory = vi.fn(() => first);
    registry = new RigSessionRegistry<FakeStore>(factory);

    expect(registry.attach('conversation-1')).toBe(first);
    registry.detach('conversation-1');
    expect(registry.attach('conversation-1', () => fakeStore('unused'))).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(registry.getActiveSessions()).toEqual([first]);
  });

  it('keeps several sessions stable through repeated view detach and reattach cycles', () => {
    registry = new RigSessionRegistry<FakeStore>();
    const stores = Array.from({ length: 4 }, (_, index) => fakeStore(`conversation-${index + 1}`));
    for (const store of stores) registry.attach(store.conversationId, () => store);

    for (let cycle = 0; cycle < 100; cycle += 1) {
      for (const store of stores) {
        registry.detach(store.conversationId);
        expect(registry.attach(store.conversationId, () => fakeStore('unused'))).toBe(store);
      }
    }

    expect(stores.every((store) => store.dispose.mock.calls.length === 0)).toBe(true);
    expect(registry.getActiveSessions()).toEqual(stores);
  });

  it('stops a store exactly once, including repeated stop calls', async () => {
    registry = new RigSessionRegistry<FakeStore>();
    const store = fakeStore('conversation-1');
    registry.attach('conversation-1', () => store);

    await Promise.all([registry.stop('conversation-1'), registry.stop('conversation-1')]);

    expect(store.dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    expect(registry.get('conversation-1')).toBeNull();
  });

  it('removes all entries immediately and bounds a hanging stopAll', async () => {
    registry = new RigSessionRegistry<FakeStore>();
    const hanging = fakeStore('hanging', () => new Promise<void>(() => {}));
    const quick = fakeStore('quick');
    registry.attach('hanging', () => hanging);
    registry.attach('quick', () => quick);

    await registry.stopAll('renderer-shutdown', 10);

    expect(hanging.dispose).toHaveBeenCalledTimes(1);
    expect(quick.dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    expect(registry.getActiveSessions()).toEqual([]);
  });

  it('rejects a factory that returns a different conversation id', () => {
    registry = new RigSessionRegistry<FakeStore>();

    expect(() => registry.attach('expected', () => fakeStore('wrong'))).toThrow(
      'Rig session factory returned wrong for expected'
    );
    expect(registry.size).toBe(0);
  });

  it('merges retained live ids without inventing an active tab', () => {
    expect(mergeRestoredConversationIds(['stored'], ['retained', 'stored'], null)).toEqual(
      new Set(['stored', 'retained'])
    );
    expect(mergeRestoredConversationIds([], ['retained'], 'target')).toEqual(
      new Set(['retained', 'target'])
    );
  });
});
