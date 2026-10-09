import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join as joinPath } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigSlug, validateRigName, type RigCreateError } from '@shared/rig/create';
import {
  rigSpaceSetupChannel,
  type SpaceSetup,
  type SpaceSetupError,
  type SpaceSetupEvent,
} from '@shared/rig/space-setup';
import { findBindingConfig } from './binding';
import {
  flagAsSpace,
  interpretGoLive,
  interpretInitFailure,
  runRig,
  type GoLive,
  type SpawnOutcome,
} from './create';
import { ensureRigHomeDir, resolveHomeLandingDir } from './home';

/**
 * Instant new space (see `shared/rig/space-setup.ts`). `start` makes the
 * folder and returns at once, so the renderer can open the Room under its
 * name; the rest runs here in the background, independent of which screen
 * the renderer is on:
 *
 *   1. `rig init --json --live --kind space --defer-upload` — ONE CLI
 *      process that writes rig.toml, creates the binding on the relay as a
 *      space (tapd init --kind space), and starts the daemon. With
 *      --defer-upload tapd returns as soon as the binding exists; the
 *      daemon's first scan uploads the files moments later.
 *   2. Only for an older CLI (no `--live`: "Unknown flag"), the old two
 *      steps: `rig init --json --sync`, then `rig sync --json`; and only if
 *      the binding didn't come back as a space (older CLI or tapd), the
 *      separate `PATCH kind` (`flagAsSpace`).
 *
 * A retry after a failed go-live finds rig.toml already there and runs
 * `rig sync --json --kind space --defer-upload` instead. Each finished run
 * logs one line with per-step milliseconds.
 */

/** Init + bind + daemon start in one process: binding creation is one relay round trip, plus process starts. */
const SETUP_TIMEOUT_MS = 60_000;
const INIT_TIMEOUT_MS = 20_000;

const NEW_SPACE_ARGS = ['init', '--json', '--live', '--kind', 'space', '--defer-upload'];
const BIND_SPACE_ARGS = ['sync', '--json', '--kind', 'space', '--defer-upload'];

/** An older rig CLI refusing the new flags (its unknown-flag guard). */
function isUnknownFlag(outcome: SpawnOutcome): boolean {
  if (outcome.kind !== 'ran' || outcome.exitCode === 0) return false;
  return /Unknown flags? --/.test(outcome.stdout) || /Unknown flags? --/.test(outcome.stderr);
}

export type SpaceSetupDeps = {
  runRig: (args: string[], cwd: string, timeoutMs: number) => Promise<SpawnOutcome>;
  /** Marks the binding a space on the relay; true when it did. */
  flagAsSpace: (dir: string) => Promise<boolean>;
  hasBinding: (dir: string) => boolean;
  hasManifest: (dir: string) => boolean;
  /** Deletes a folder this setup made (only ever called with no binding in it). */
  removeDir: (dir: string) => void;
  emit: (event: SpaceSetupEvent) => void;
  log: (message: string, extra: Record<string, unknown>) => void;
  now: () => number;
  newId: () => string;
  onCreated?: () => void;
};

export type SpaceSetups = ReturnType<typeof createSpaceSetups>;

export function createSpaceSetups(deps: SpaceSetupDeps) {
  const setups = new Map<string, SpaceSetup>();
  const running = new Map<string, Promise<void>>();

  const update = (id: string, patch: Partial<SpaceSetup>): SpaceSetup | null => {
    const current = setups.get(id);
    if (!current) return null; // removed meanwhile
    const next = { ...current, ...patch };
    setups.set(id, next);
    deps.emit(next);
    return next;
  };

  /** The background pipeline. Never throws; ends live or failed. */
  const run = async (id: string): Promise<void> => {
    const setup = setups.get(id);
    if (!setup) return;
    const dir = setup.path;
    const started = deps.now();
    const ms: Record<string, number> = {};
    const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = deps.now();
      try {
        return await fn();
      } finally {
        ms[label] = (ms[label] ?? 0) + deps.now() - t0;
      }
    };
    let path: 'oneStep' | 'twoStep' | 'bind' | 'bindFallback' = 'oneStep';
    const fail = (error: SpaceSetupError) => {
      update(id, { status: 'failed', error, removable: !deps.hasBinding(dir) });
      deps.log('Rig create: space setup failed', { path, totalMs: deps.now() - started, ...ms, code: error.code });
    };

    update(id, { status: 'working', step: 'goingLive', error: null });
    let live: Result<GoLive, SpaceSetupError>;
    if (!deps.hasManifest(dir)) {
      const outcome = await timed('cliMs', () => deps.runRig(NEW_SPACE_ARGS, dir, SETUP_TIMEOUT_MS));
      if (isUnknownFlag(outcome)) {
        // An older CLI: rig.toml first, then go live, as before.
        path = 'twoStep';
        const init = await timed('initMs', () => deps.runRig(['init', '--json', '--sync'], dir, INIT_TIMEOUT_MS));
        const initError = interpretInitFailure(init);
        if (initError) return fail({ code: initError.code ?? initError.kind, message: initError.message });
        deps.onCreated?.();
        live = interpretGoLive(await timed('syncMs', () => deps.runRig(['sync', '--json'], dir, SETUP_TIMEOUT_MS)), 'sync');
      } else {
        // An error envelope here is `rig init` itself failing (the go-live
        // part reports `state: 'local'` + `syncError` instead).
        const initError = outcome.kind === 'ran' && deps.hasManifest(dir) ? null : interpretInitFailure(outcome);
        if (initError) return fail({ code: initError.code ?? initError.kind, message: initError.message });
        deps.onCreated?.();
        live = interpretGoLive(outcome, 'init');
      }
    } else {
      // Retrying a failed go-live: the rig exists; bind it.
      path = 'bind';
      const outcome = await timed('syncMs', () => deps.runRig(BIND_SPACE_ARGS, dir, SETUP_TIMEOUT_MS));
      if (isUnknownFlag(outcome)) {
        path = 'bindFallback';
        live = interpretGoLive(await timed('syncMs', () => deps.runRig(['sync', '--json'], dir, SETUP_TIMEOUT_MS)), 'sync');
      } else {
        live = interpretGoLive(outcome, 'sync');
      }
    }
    if (!live.success) return fail(live.error);

    // The CLI made it a space (tapd 0.6.7+ echoes the relay's kind); otherwise mark it.
    if (live.data.kind !== 'space') {
      update(id, { step: 'markingSpace' });
      await timed('markSpaceMs', () => deps.flagAsSpace(dir));
    }
    const bindingId = live.data.bindingId ?? null;
    update(id, { status: 'live', step: 'live', bindingId, homeUrl: live.data.homeUrl, error: null, removable: false });
    deps.log('Rig create: space setup timings', { path, totalMs: deps.now() - started, ...ms });
  };

  const launch = (id: string) => {
    const pending = run(id)
      .catch((error: unknown) => {
        update(id, {
          status: 'failed',
          error: { code: 'error', message: error instanceof Error ? error.message : String(error) },
          removable: !deps.hasBinding(setups.get(id)?.path ?? ''),
        });
      })
      .finally(() => running.delete(id));
    running.set(id, pending);
    return pending;
  };

  return {
    /** Registers a setup for a folder that already exists, and starts it. */
    start(name: string, path: string): SpaceSetup {
      const setup: SpaceSetup = {
        id: deps.newId(),
        name,
        path,
        status: 'working',
        step: 'goingLive',
        bindingId: null,
        homeUrl: null,
        error: null,
        removable: true,
      };
      setups.set(setup.id, setup);
      void launch(setup.id);
      return setup;
    },
    list(): SpaceSetup[] {
      return [...setups.values()];
    },
    /** Runs a failed setup again (a no-op while it's still running, or once live). */
    retry(id: string): SpaceSetup | null {
      const setup = setups.get(id);
      if (!setup) return null;
      if (setup.status === 'failed' && !running.has(id)) void launch(id);
      return setups.get(id) ?? null;
    },
    /**
     * Forgets a setup. Deletes its folder only when nothing usable was made
     * (no binding here) and it isn't mid-run; otherwise the folder stays.
     */
    remove(id: string): { removedFolder: boolean } | null {
      const setup = setups.get(id);
      if (!setup) return null;
      if (running.has(id)) return { removedFolder: false };
      let removedFolder = false;
      if (setup.status !== 'live' && !deps.hasBinding(setup.path)) {
        try {
          deps.removeDir(setup.path);
          removedFolder = true;
        } catch (error) {
          deps.log('Rig create: could not remove a failed space folder', { error: String(error) });
        }
      }
      setups.delete(id);
      deps.emit({ ...setup, removed: true });
      return { removedFolder };
    },
    /** Test seam: the pipeline promise for a setup, when one is running. */
    whenSettled(id: string): Promise<void> {
      return running.get(id) ?? Promise.resolve();
    },
  };
}

const spaceSetups = createSpaceSetups({
  runRig,
  flagAsSpace,
  hasBinding: (dir) => findBindingConfig(dir)?.workspaceRoot === dir,
  hasManifest: (dir) => existsSync(joinPath(dir, 'rig.toml')),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  emit: (event) => events.emit(rigSpaceSetupChannel, event),
  log: (message, extra) => log.info(message, extra),
  now: () => Date.now(),
  newId: () => randomUUID(),
  onCreated: () => telemetryService.capture('rig_created', {}),
});

/** `start` when the Rig home folder can't be made (say, `~/Rig` is a file). */
export const RIG_HOME_FAILED = "Rig couldn't make its folder in your home folder.";

export const rigSpaceSetupController = createRPCController({
  /**
   * Makes the new space's folder under the Rig home and returns at once;
   * setup continues in the background (`rigSpaceSetupChannel` events).
   */
  start: async ({ name }: { name: string }): Promise<Result<SpaceSetup, RigCreateError>> => {
    const invalid = validateRigName(name);
    if (invalid) return err<RigCreateError>({ kind: 'invalidName', message: invalid });
    let home: string;
    try {
      home = await ensureRigHomeDir();
    } catch (error) {
      log.warn('Rig space setup: could not make the Rig home folder', {
        error: error instanceof Error ? error.message : String(error),
      });
      return err<RigCreateError>({ kind: 'initFailed', message: RIG_HOME_FAILED });
    }
    const targetDir = resolveHomeLandingDir(home, rigSlug(name));
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (error) {
      return err<RigCreateError>({
        kind: 'initFailed',
        message: `Could not create the folder: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return ok(spaceSetups.start(basename(targetDir), targetDir));
  },
  /** Setups this app session started: running, failed, or live. */
  list: async (): Promise<SpaceSetup[]> => spaceSetups.list(),
  retry: async ({ id }: { id: string }): Promise<SpaceSetup | null> => spaceSetups.retry(id),
  remove: async ({ id }: { id: string }): Promise<{ removedFolder: boolean } | null> => spaceSetups.remove(id),
});
