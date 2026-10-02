import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_LAYOUT, type HomeLayout } from '@shared/rig/home-layout';
import {
  HomeLayoutSync,
  RETRY_DELAY_MS,
  type HomeLayoutCache,
  type HomeLayoutPutResult,
  type SyncedLayout,
} from './home-layout-sync';

/** A relay holding one copy, with the same version rule as the real route. */
function fakeRelay(initial: SyncedLayout = { layout: DEFAULT_HOME_LAYOUT, version: 0 }) {
  const relay = {
    copy: initial,
    reachable: true,
    reject: false,
    puts: 0,
    async get() {
      return relay.reachable
        ? ({ kind: 'ok', synced: relay.copy } as const)
        : ({ kind: 'failed' } as const);
    },
    async put(layout: HomeLayout, version: number): Promise<HomeLayoutPutResult> {
      relay.puts += 1;
      if (!relay.reachable) return { kind: 'failed' };
      if (relay.reject) return { kind: 'rejected' };
      if (version !== relay.copy.version) return { kind: 'conflict', synced: relay.copy };
      relay.copy = { layout, version: version + 1 };
      return { kind: 'saved', synced: relay.copy };
    },
  };
  return relay;
}

function setup(
  opts: {
    relay?: ReturnType<typeof fakeRelay>;
    cache?: HomeLayoutCache;
    account?: string | null;
  } = {}
) {
  const relay = opts.relay ?? fakeRelay();
  const disk = new Map<string, HomeLayoutCache>();
  if (opts.cache) disk.set('acct@relay', opts.cache);
  const emitted: HomeLayout[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let account: string | null = opts.account === undefined ? 'acct@relay' : opts.account;
  let clock = 1_000_000;
  const sync = new HomeLayoutSync({
    relay,
    store: {
      account: async () => account,
      read: async (a) => disk.get(a) ?? null,
      write: async (a, c) => void disk.set(a, structuredClone(c)),
    },
    emit: (layout) => emitted.push(layout),
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    now: () => clock,
  });
  /** Runs every timer due so far (not ones they schedule). */
  const runTimers = async () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    sync,
    relay,
    disk,
    emitted,
    timers,
    runTimers,
    setAccount: (a: string | null) => {
      account = a;
    },
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const create = (id: string, spaces: string[] = []) =>
  ({ type: 'createGroup', id, name: id, spaces }) as const;

describe('HomeLayoutSync', () => {
  it('shows an edit at once, caches it, and saves it on the relay shortly after', async () => {
    const t = setup();
    const shown = await t.sync.apply(create('g1', ['s1']));
    expect(shown.groups.map((g) => g.id)).toEqual(['g1']);
    expect(t.disk.get('acct@relay')!.pending).toHaveLength(1);
    expect(t.relay.puts).toBe(0);
    await t.sync.flush();
    expect(t.relay.copy.version).toBe(1);
    expect(t.relay.copy.layout.groups[0]!.spaces).toEqual(['s1']);
    expect(t.disk.get('acct@relay')).toEqual({ base: t.relay.copy, pending: [] });
  });

  it('sends edits made close together as one save', async () => {
    const t = setup();
    await t.sync.apply(create('g1'));
    await t.sync.apply({ type: 'renameGroup', id: 'g1', name: 'Launch' });
    await t.sync.apply({ type: 'setGroupBy', groupBy: 'state' });
    await t.runTimers();
    await t.sync.flush();
    expect(t.relay.puts).toBe(1);
    expect(t.relay.copy.layout).toMatchObject({
      groupBy: 'state',
      groups: [{ id: 'g1', name: 'Launch' }],
    });
  });

  it("on a conflict, replays its edits on the other computer's copy instead of overwriting it", async () => {
    const theirs: HomeLayout = {
      ...DEFAULT_HOME_LAYOUT,
      groups: [{ id: 'other', name: 'Other', collapsed: false, spaces: ['s9'] }],
    };
    const relay = fakeRelay({ layout: theirs, version: 4 });
    // This computer last saw version 3.
    const t = setup({
      relay,
      cache: { base: { layout: DEFAULT_HOME_LAYOUT, version: 3 }, pending: [] },
    });
    await t.sync.apply(create('mine', ['s1']));
    await t.sync.flush();
    expect(relay.copy.version).toBe(5);
    expect(relay.copy.layout.groups.map((g) => g.id)).toEqual(['other', 'mine']);
    expect(t.sync.displayed()).toEqual(relay.copy.layout);
  });

  it('offline: keeps the edits on disk and saves them after a relaunch', async () => {
    const relay = fakeRelay();
    relay.reachable = false;
    const first = setup({ relay });
    await first.sync.apply(create('g1', ['s1']));
    await first.sync.flush();
    expect(relay.copy.version).toBe(0);
    expect(first.timers.some((t) => t.ms === RETRY_DELAY_MS && !t.cancelled)).toBe(true);

    // Relaunch: a new instance reads the cache, shows the edit, and saves it once the relay is back.
    relay.reachable = true;
    const second = setup({ relay, cache: first.disk.get('acct@relay')! });
    expect((await second.sync.get()).groups.map((g) => g.id)).toEqual(['g1']);
    await second.runTimers();
    await second.sync.flush();
    expect(relay.copy).toMatchObject({
      version: 1,
      layout: { groups: [{ id: 'g1', spaces: ['s1'] }] },
    });
  });

  it('picks up a newer copy from the relay and tells Home', async () => {
    const relay = fakeRelay();
    const t = setup({
      relay,
      cache: { base: { layout: DEFAULT_HOME_LAYOUT, version: 0 }, pending: [] },
    });
    relay.copy = { layout: { ...DEFAULT_HOME_LAYOUT, sortBy: 'name' }, version: 2 };
    await t.sync.refresh();
    expect(t.emitted.at(-1)).toMatchObject({ sortBy: 'name' });
    expect(t.disk.get('acct@relay')!.base.version).toBe(2);
  });

  it('drops edits the relay refuses for good, and shows its copy again', async () => {
    const relay = fakeRelay();
    relay.reject = true;
    const t = setup({ relay });
    await t.sync.apply(create('g1'));
    await t.sync.flush();
    expect(t.sync.displayed().groups).toEqual([]);
    expect(t.emitted.at(-1)!.groups).toEqual([]);
  });

  it("never shows one account's layout to another", async () => {
    const t = setup();
    await t.sync.apply(create('g1'));
    t.setAccount('someone-else@relay');
    expect((await t.sync.get()).groups).toEqual([]);
    t.setAccount(null);
    expect((await t.sync.get()).groups).toEqual([]);
  });
});
