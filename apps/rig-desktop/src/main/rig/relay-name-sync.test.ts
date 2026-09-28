import { err, ok } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRelayNameSync,
  nameToPush,
  renameWarning,
  type LocalRigName,
  type RelayBindingName,
  type RelayNameFailure,
} from './relay-name-sync';

const T0 = Date.parse('2026-09-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('nameToPush', () => {
  const relay: RelayBindingName = { id: 'b1', name: 'clear-harbor', role: 'editor', updatedAt: iso(T0) };

  it('pushes a rig.toml name written after the relay last changed', () => {
    expect(nameToPush({ name: 'rig-feedback', mtimeMs: T0 + 1 }, relay)).toBe('rig-feedback');
  });

  it("never pushes a rig.toml older than the relay's change (a member whose copy hasn't synced yet)", () => {
    expect(nameToPush({ name: 'old-name', mtimeMs: T0 }, relay)).toBeNull();
    expect(nameToPush({ name: 'old-name', mtimeMs: T0 - 5_000 }, relay)).toBeNull();
  });

  it('leaves matching names alone, comparing them the way the relay normalizes', () => {
    expect(nameToPush({ name: '  clear-harbor ', mtimeMs: T0 + 1 }, relay)).toBeNull();
    expect(
      nameToPush({ name: 'Launch\n planning', mtimeMs: T0 + 1 }, { ...relay, name: 'Launch planning' })
    ).toBeNull();
  });

  it('only owners and editors push', () => {
    expect(nameToPush({ name: 'x', mtimeMs: T0 + 1 }, { ...relay, role: 'owner' })).toBe('x');
    expect(nameToPush({ name: 'x', mtimeMs: T0 + 1 }, { ...relay, role: 'viewer' })).toBeNull();
  });

  it('skips a name the relay would refuse, and a missing rig.toml', () => {
    expect(nameToPush({ name: '   ', mtimeMs: T0 + 1 }, relay)).toBeNull();
    expect(nameToPush({ name: 'x'.repeat(81), mtimeMs: T0 + 1 }, relay)).toBeNull();
    expect(nameToPush({ name: 'x'.repeat(80), mtimeMs: T0 + 1 }, relay)).toBe('x'.repeat(80));
    expect(nameToPush(null, relay)).toBeNull();
  });

  it('pushes when the relay sent no updatedAt', () => {
    expect(nameToPush({ name: 'x', mtimeMs: 0 }, { id: 'b1', name: 'y', role: 'owner' })).toBe('x');
  });
});

describe('renameWarning', () => {
  it('says nothing for a local-only rename (signed out, untrusted relay, expired sign-in)', () => {
    expect(renameWarning({ kind: 'notSignedIn', message: 'Not signed in to Rig.' })).toBeNull();
    expect(renameWarning({ kind: 'invalidToken', message: 'expired' })).toBeNull();
  });

  it("says nothing when an old relay ignores `name` (400 no_changes)", () => {
    expect(renameWarning({ kind: 'relay', status: 400, code: 'no_changes', message: 'm' })).toBeNull();
  });

  it('warns on any other relay refusal or an unreachable relay', () => {
    expect(renameWarning({ kind: 'relay', status: 403, code: 'forbidden', message: 'Could not (relay: forbidden).' }))
      .toContain('relay: forbidden');
    expect(renameWarning({ kind: 'relay', message: 'unreachable' })).toContain('unreachable');
  });
});

/**
 * A fake relay: PATCH renames and bumps updatedAt like the real one, or
 * (`old`) answers the way a relay from before renames did.
 */
function fakeRelay(bindings: RelayBindingName[], opts: { old?: boolean; now?: () => number } = {}) {
  const rows = new Map(bindings.map((b) => [b.id, { ...b }]));
  const patches: Array<{ bindingId: string; name: string }> = [];
  const patchName = vi.fn(async (bindingId: string, name: string) => {
    patches.push({ bindingId, name });
    const row = rows.get(bindingId);
    if (opts.old) {
      return err<RelayNameFailure>({ kind: 'relay', status: 400, code: 'no_changes', message: 'no_changes' });
    }
    if (!row) return err<RelayNameFailure>({ kind: 'relay', status: 404, code: 'not_found', message: 'not_found' });
    if (row.role === 'viewer') {
      return err<RelayNameFailure>({ kind: 'relay', status: 403, code: 'forbidden', message: 'forbidden' });
    }
    row.name = name;
    row.updatedAt = iso((opts.now ?? Date.now)());
    return ok(undefined);
  });
  return { rows, patches, patchName, list: () => [...rows.values()].map((r) => ({ ...r })) };
}

function syncFor(
  relay: ReturnType<typeof fakeRelay>,
  local: Record<string, LocalRigName | null>,
  onPushed = vi.fn()
) {
  return {
    onPushed,
    sync: createRelayNameSync({
      patchName: relay.patchName,
      listBindings: async () => relay.list(),
      localPaths: async (ids) => Object.fromEntries(ids.filter((id) => id in local).map((id) => [id, `/rigs/${id}`])),
      readLocal: async (path) => local[path.slice('/rigs/'.length)] ?? null,
      onPushed,
      debounceMs: 50,
    }),
  };
}

describe('createRelayNameSync', () => {
  it('reconcile pushes an out-of-band rig.toml rename once, and tells the app', async () => {
    const relay = fakeRelay([{ id: 'b1', name: 'clear-harbor', role: 'owner', updatedAt: iso(T0) }], { now: () => T0 + 10 });
    const { sync, onPushed } = syncFor(relay, { b1: { name: 'rig-feedback', mtimeMs: T0 + 5 } });

    await sync.reconcile(relay.list());
    expect(relay.patches).toEqual([{ bindingId: 'b1', name: 'rig-feedback' }]);
    expect(relay.rows.get('b1')?.name).toBe('rig-feedback');
    expect(onPushed).toHaveBeenCalledWith('b1', 'rig-feedback');

    // The next Home refresh sees matching names: nothing to do.
    await sync.reconcile(relay.list());
    expect(relay.patches).toHaveLength(1);
  });

  it("doesn't fight between members: a member with an unsynced rig.toml leaves the relay alone", async () => {
    // A renamed at T0+5 and A's app pushed it (relay updatedAt T0+10).
    const relay = fakeRelay([{ id: 'b1', name: 'rig-feedback', role: 'editor', updatedAt: iso(T0 + 10) }]);
    // B's rig.toml still has the old name, last written before that.
    const b = syncFor(relay, { b1: { name: 'clear-harbor', mtimeMs: T0 } });
    await b.sync.reconcile(relay.list());
    expect(relay.patches).toEqual([]);

    // Then the new rig.toml syncs down to B: names match, still nothing.
    const bLater = syncFor(relay, { b1: { name: 'rig-feedback', mtimeMs: T0 + 20 } });
    await bLater.sync.reconcile(relay.list());
    expect(relay.patches).toEqual([]);
  });

  it('skips viewers and bindings with no local copy', async () => {
    const relay = fakeRelay([
      { id: 'viewer', name: 'a', role: 'viewer', updatedAt: iso(T0) },
      { id: 'remote', name: 'b', role: 'owner', updatedAt: iso(T0) },
    ]);
    const { sync } = syncFor(relay, { viewer: { name: 'a2', mtimeMs: T0 + 1 } });
    await sync.reconcile(relay.list());
    expect(relay.patches).toEqual([]);
  });

  it('asks an old relay (no renames) once per name, not on every refresh', async () => {
    const relay = fakeRelay([{ id: 'b1', name: 'clear-harbor', role: 'owner', updatedAt: iso(T0) }], { old: true });
    const { sync, onPushed } = syncFor(relay, { b1: { name: 'rig-feedback', mtimeMs: T0 + 1 } });
    await sync.reconcile(relay.list());
    await sync.reconcile(relay.list());
    expect(relay.patches).toHaveLength(1);
    expect(onPushed).not.toHaveBeenCalled();
  });

  it('pushRename always asks the relay and returns the quiet warning, if any', async () => {
    const relay = fakeRelay([
      { id: 'b1', name: 'a', role: 'owner', updatedAt: iso(T0) },
      { id: 'v', name: 'c', role: 'viewer', updatedAt: iso(T0) },
    ]);
    const { sync, onPushed } = syncFor(relay, {});
    expect(await sync.pushRename('b1', '  Launch planning ')).toBeNull();
    expect(relay.rows.get('b1')?.name).toBe('Launch planning');
    expect(await sync.pushRename('v', 'nope')).toContain('forbidden');
    // renameRig tells the app itself; onPushed is for reconcile's pushes.
    expect(onPushed).not.toHaveBeenCalled();

    const old = fakeRelay([{ id: 'b1', name: 'a', role: 'owner', updatedAt: iso(T0) }], { old: true });
    expect(await syncFor(old, {}).sync.pushRename('b1', 'b')).toBeNull();
  });

  describe('noteLocalName (the open rig watcher)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('reconciles once, debounced, when the name is new or changes; not for repeats', async () => {
      const relay = fakeRelay([{ id: 'b1', name: 'clear-harbor', role: 'owner', updatedAt: iso(T0) }], { now: () => T0 + 10 });
      const local: Record<string, LocalRigName | null> = { b1: { name: 'clear-harbor', mtimeMs: T0 - 1 } };
      const { sync } = syncFor(relay, local);
      const listSpy = vi.fn();
      const originalList = relay.list;
      relay.list = () => {
        listSpy();
        return originalList();
      };

      sync.noteLocalName('/rigs/b1', 'clear-harbor');
      sync.noteLocalName('/rigs/b1', 'clear-harbor');
      await vi.advanceTimersByTimeAsync(60);
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(relay.patches).toEqual([]);

      // An agent edits rig.toml; the watcher fires a burst of reads.
      local.b1 = { name: 'rig-feedback', mtimeMs: T0 + 5 };
      sync.noteLocalName('/rigs/b1', 'rig-feedback');
      sync.noteLocalName('/rigs/b1', 'rig-feedback');
      await vi.advanceTimersByTimeAsync(60);
      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(relay.patches).toEqual([{ bindingId: 'b1', name: 'rig-feedback' }]);
    });
  });
});
