import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { DeleteRigInput } from '@shared/rig/delete-rig';
import type { DeleteRigDeps } from './delete-rig';

// `delete-rig.ts` imports `forgetRig` from `./recent-rigs`, which imports
// `@main/db/client` at module scope — a real (Electron-compiled)
// better-sqlite3 handle as a side effect of import, fatal under this
// file's plain `node` project (see `recent-rigs.test.ts`'s own comment for
// the same trick). `deleteRigImpl` below is exercised entirely through
// fake `DeleteRigDeps` and never touches the real `db`, so the mock never
// needs a real fixture behind it.
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const { deleteRigImpl } = await import('./delete-rig');

function fakeDeps(overrides: Partial<DeleteRigDeps> = {}): DeleteRigDeps {
  return {
    stopSync: vi.fn(async () => ok({ paused: true })),
    callRelay: vi.fn(async () => ok({ ok: true as const })),
    forgetLocal: vi.fn(async () => {}),
    trashFolder: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
}

const DELETE_INPUT: DeleteRigInput = {
  bindingId: 'b1',
  path: '/Users/dylan/Rig/roadmap',
  mode: 'delete',
  trashFolder: false,
};

describe('deleteRigImpl — step ordering', () => {
  it('runs stopSync, then the relay call, then forgetLocal, in that order', async () => {
    const calls: string[] = [];
    const deps = fakeDeps({
      stopSync: vi.fn(async () => {
        calls.push('stopSync');
        return ok({ paused: true });
      }),
      callRelay: vi.fn(async () => {
        calls.push('relay');
        return ok({ ok: true as const });
      }),
      forgetLocal: vi.fn(async () => {
        calls.push('forget');
      }),
    });

    const result = await deleteRigImpl(DELETE_INPUT, deps);

    expect(result).toEqual(ok({ trashWarning: null }));
    expect(calls).toEqual(['stopSync', 'relay', 'forget']);
  });

  it('trashes the folder last, only when requested and only after everything else succeeded', async () => {
    const calls: string[] = [];
    const deps = fakeDeps({
      forgetLocal: vi.fn(async () => {
        calls.push('forget');
      }),
      trashFolder: vi.fn(async (path: string) => {
        calls.push(`trash:${path}`);
        return ok(undefined);
      }),
    });

    await deleteRigImpl({ ...DELETE_INPUT, trashFolder: true }, deps);

    expect(calls).toEqual(['forget', `trash:${DELETE_INPUT.path}`]);
    expect(deps.trashFolder).toHaveBeenCalledTimes(1);
  });

  it('never trashes when trashFolder is false', async () => {
    const deps = fakeDeps();
    await deleteRigImpl({ ...DELETE_INPUT, trashFolder: false }, deps);
    expect(deps.trashFolder).not.toHaveBeenCalled();
  });

  it('skips the trash step entirely for a relay-only row with no local path', async () => {
    const deps = fakeDeps();
    await deleteRigImpl({ ...DELETE_INPUT, path: null, trashFolder: true }, deps);
    expect(deps.trashFolder).not.toHaveBeenCalled();
    expect(deps.stopSync).not.toHaveBeenCalled();
  });

  it("mode: 'local' skips the relay call entirely", async () => {
    const deps = fakeDeps();
    const result = await deleteRigImpl({ ...DELETE_INPUT, mode: 'local' }, deps);
    expect(deps.callRelay).not.toHaveBeenCalled();
    expect(deps.forgetLocal).toHaveBeenCalledTimes(1);
    expect(result).toEqual(ok({ trashWarning: null }));
  });

  it("mode: 'leave' calls the relay with 'leave'", async () => {
    const deps = fakeDeps();
    await deleteRigImpl({ ...DELETE_INPUT, mode: 'leave' }, deps);
    expect(deps.callRelay).toHaveBeenCalledWith('b1', 'leave');
  });
});

describe('deleteRigImpl — failure handling', () => {
  it('a stopSync failure aborts before the relay call and before forgetting the row', async () => {
    const deps = fakeDeps({
      stopSync: vi.fn(async () => err({ message: "Couldn't pause this rig." })),
    });

    const result = await deleteRigImpl(DELETE_INPUT, deps);

    expect(result).toEqual(err({ kind: 'localFailure', message: "Couldn't pause this rig." }));
    expect(deps.callRelay).not.toHaveBeenCalled();
    expect(deps.forgetLocal).not.toHaveBeenCalled();
  });

  it('a relay failure leaves sync paused and the local row intact — no forgetLocal, no trash', async () => {
    const deps = fakeDeps({
      callRelay: vi.fn(async () =>
        err({ kind: 'forbiddenOwnerOnly' as const, message: 'Only the owner can delete this rig. You can leave it instead.' })
      ),
    });

    const result = await deleteRigImpl({ ...DELETE_INPUT, trashFolder: true }, deps);

    expect(result).toEqual(
      err({
        kind: 'forbiddenOwnerOnly',
        message: 'Only the owner can delete this rig. You can leave it instead.',
      })
    );
    // stopSync already ran (sync is paused) — but the row and the folder are untouched.
    expect(deps.stopSync).toHaveBeenCalledTimes(1);
    expect(deps.forgetLocal).not.toHaveBeenCalled();
    expect(deps.trashFolder).not.toHaveBeenCalled();
  });

  it('a failed trash does not fail the overall delete — the rig is still fully removed', async () => {
    const deps = fakeDeps({
      trashFolder: vi.fn(async () => err({ message: 'Could not move the folder to the Trash: EPERM' })),
    });

    const result = await deleteRigImpl({ ...DELETE_INPUT, trashFolder: true }, deps);

    expect(result).toEqual(ok({ trashWarning: 'Could not move the folder to the Trash: EPERM' }));
    expect(deps.forgetLocal).toHaveBeenCalledTimes(1);
  });
});
