import { describe, expect, it, vi } from 'vitest';
import type { SpaceSetupEvent } from '@shared/rig/space-setup';

vi.mock('@main/lib/telemetry', () => ({ telemetryService: { capture: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn() } }));

import type { SpawnOutcome } from './create';
import { createSpaceSetups, type SpaceSetupDeps } from './space-setup';

const ran = (body: unknown, exitCode = 0): SpawnOutcome => ({
  kind: 'ran',
  exitCode,
  stdout: `${JSON.stringify(body)}\n`,
  stderr: '',
});

const LIVE_SPACE = ran({
  protocolVersion: 1,
  name: 'bright-harbor',
  sync: true,
  live: true,
  path: '/home/bright-harbor',
  state: 'live',
  workspace: { bindingId: 'bnd_1', homeUrl: 'https://userig.xyz/home/workspaces/bnd_1', kind: 'space' },
});

/** A fake folder + CLI: `answers` are the CLI's replies in order; rig.toml appears once `rig init` has run. */
function harness(answers: SpawnOutcome[], overrides: Partial<SpaceSetupDeps> = {}) {
  const calls: string[][] = [];
  const emitted: SpaceSetupEvent[] = [];
  const logs: Array<{ message: string; extra: Record<string, unknown> }> = [];
  let manifest = false;
  let binding = false;
  let clock = 0;
  const removed: string[] = [];
  const deps: SpaceSetupDeps = {
    runRig: async (args) => {
      calls.push(args);
      clock += 100;
      const answer = answers.shift() ?? ran({ error: { code: 'error', message: 'no more answers' } }, 1);
      if (args[0] === 'init' && answer.kind === 'ran' && answer.exitCode === 0) manifest = true;
      if (answer.kind === 'ran' && answer.stdout.includes('"state":"live"')) binding = true;
      return answer;
    },
    flagAsSpace: vi.fn(async () => true),
    hasBinding: () => binding,
    hasManifest: () => manifest,
    removeDir: (dir) => removed.push(dir),
    emit: (event) => emitted.push(event),
    log: (message, extra) => logs.push({ message, extra }),
    now: () => clock,
    newId: () => 'setup-1',
    ...overrides,
  };
  const setups = createSpaceSetups(deps);
  return {
    setups,
    deps,
    calls,
    emitted,
    logs,
    removed,
    setManifest: (v: boolean) => (manifest = v),
  };
}

describe('space setup', () => {
  it('returns at once, then goes live with ONE CLI call that creates a space and defers the upload', async () => {
    const h = harness([LIVE_SPACE]);
    const started = h.setups.start('bright-harbor', '/home/bright-harbor');
    expect(started).toMatchObject({ id: 'setup-1', name: 'bright-harbor', status: 'working', bindingId: null });

    await h.setups.whenSettled('setup-1');
    expect(h.calls).toEqual([['init', '--json', '--live', '--kind', 'space', '--defer-upload']]);
    // The CLI made it a space: no separate PATCH.
    expect(h.deps.flagAsSpace).not.toHaveBeenCalled();
    expect(h.setups.list()[0]).toMatchObject({
      status: 'live',
      step: 'live',
      bindingId: 'bnd_1',
      homeUrl: 'https://userig.xyz/home/workspaces/bnd_1',
      removable: false,
    });
    expect(h.emitted.map((e) => e.status)).toEqual(['working', 'live']);
    // One timing line per creation.
    expect(h.logs).toEqual([
      { message: 'Rig create: space setup timings', extra: { path: 'oneStep', totalMs: 100, cliMs: 100 } },
    ]);
  });

  it('marks the binding a space when the CLI made a plain rig (tapd before 0.6.7 ignores --kind)', async () => {
    const h = harness([ran({ state: 'live', workspace: { bindingId: 'bnd_1', homeUrl: null } })]);
    h.setups.start('s', '/home/s');
    await h.setups.whenSettled('setup-1');
    expect(h.deps.flagAsSpace).toHaveBeenCalledWith('/home/s');
    expect(h.emitted.map((e) => e.step)).toEqual(['goingLive', 'markingSpace', 'live']);
    expect(h.setups.list()[0]?.status).toBe('live');
  });

  it('falls back to init + sync + PATCH with a CLI that has no --live', async () => {
    const unknown: SpawnOutcome = {
      kind: 'ran',
      exitCode: 1,
      stdout:
        '{"protocolVersion":1,"error":{"code":"error","message":"Unknown flags --live, --kind, --defer-upload for `rig init`. Run `rig init --help` to see valid options."}}\n',
      stderr: '',
    };
    const h = harness([
      unknown,
      ran({ protocolVersion: 1, name: 's', sync: true, live: false, path: '/home/s' }),
      ran({ protocolVersion: 1, enabledSync: true, state: 'live', workspace: { bindingId: 'bnd_1', homeUrl: null } }),
    ]);
    h.setups.start('s', '/home/s');
    await h.setups.whenSettled('setup-1');
    expect(h.calls).toEqual([
      ['init', '--json', '--live', '--kind', 'space', '--defer-upload'],
      ['init', '--json', '--sync'],
      ['sync', '--json'],
    ]);
    expect(h.deps.flagAsSpace).toHaveBeenCalledTimes(1);
    expect(h.setups.list()[0]).toMatchObject({ status: 'live', bindingId: 'bnd_1' });
    expect(h.logs[0]?.extra).toMatchObject({ path: 'twoStep', cliMs: 100, initMs: 100, syncMs: 100 });
  });

  it('a failed go-live is an inline failure; Retry binds the rig that exists', async () => {
    const h = harness([
      ran({
        protocolVersion: 1,
        name: 's',
        sync: true,
        live: false,
        path: '/home/s',
        state: 'local',
        syncError: { code: 'error', message: "Can't reach the relay at https://tap-relay.fly.dev." },
      }),
      LIVE_SPACE,
    ]);
    h.setups.start('s', '/home/s');
    await h.setups.whenSettled('setup-1');
    expect(h.setups.list()[0]).toMatchObject({
      status: 'failed',
      removable: true,
      error: { message: "Can't reach the relay at https://tap-relay.fly.dev." },
    });

    h.setups.retry('setup-1');
    await h.setups.whenSettled('setup-1');
    expect(h.calls[1]).toEqual(['sync', '--json', '--kind', 'space', '--defer-upload']);
    expect(h.setups.list()[0]).toMatchObject({ status: 'live', bindingId: 'bnd_1', error: null });
  });

  it('an init that fails outright (nothing written) fails with the CLI’s own message', async () => {
    const h = harness([
      ran({ protocolVersion: 1, error: { code: 'error', message: 'Refusing to run rig init in your home directory.' } }, 1),
    ]);
    h.setups.start('s', '/home/s');
    await h.setups.whenSettled('setup-1');
    expect(h.setups.list()[0]).toMatchObject({
      status: 'failed',
      removable: true,
      error: { message: 'Refusing to run rig init in your home directory.' },
    });
  });

  it('a missing CLI fails honestly instead of spinning', async () => {
    const h = harness([{ kind: 'spawnFailed', bin: 'rig' }]);
    h.setups.start('s', '/home/s');
    await h.setups.whenSettled('setup-1');
    expect(h.setups.list()[0]?.status).toBe('failed');
    expect(h.setups.list()[0]?.error?.message).toMatch(/Could not run `rig`/);
  });

  it('Remove deletes the folder only when nothing usable was created', async () => {
    const h = harness([{ kind: 'timedOut' }]);
    h.setups.start('s', '/home/s');
    await h.setups.whenSettled('setup-1');
    expect(h.setups.remove('setup-1')).toEqual({ removedFolder: true });
    expect(h.removed).toEqual(['/home/s']);
    expect(h.setups.list()).toEqual([]);
    expect(h.emitted.at(-1)).toMatchObject({ id: 'setup-1', removed: true });
  });

  it('Remove keeps a folder that is bound (it is a real space on the relay)', async () => {
    const h = harness([ran({ state: 'local', syncError: { code: 'error', message: 'x' } })], {
      hasBinding: () => true,
    });
    h.setups.start('s', '/home/s');
    await h.setups.whenSettled('setup-1');
    expect(h.setups.list()[0]?.removable).toBe(false);
    expect(h.setups.remove('setup-1')).toEqual({ removedFolder: false });
    expect(h.removed).toEqual([]);
  });

  it('keeps going when nobody is watching, and a retry while running is a no-op', async () => {
    let release: (value: SpawnOutcome) => void = () => {};
    const h = harness([], {
      runRig: (args) => {
        h.calls.push(args);
        return new Promise<SpawnOutcome>((resolve) => (release = resolve));
      },
    });
    h.setups.start('s', '/home/s');
    await Promise.resolve();
    h.setups.retry('setup-1');
    expect(h.setups.remove('setup-1')).toEqual({ removedFolder: false });
    release(LIVE_SPACE);
    await h.setups.whenSettled('setup-1');
    expect(h.calls).toHaveLength(1);
  });
});
