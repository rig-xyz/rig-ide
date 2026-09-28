import { shell } from 'electron';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  deriveDeleteRigFailureMessage,
  type DeleteRigFailure,
  type DeleteRigFailureKind,
  type DeleteRigInput,
  type DeleteRigMode,
  type DeleteRigSuccess,
} from '@shared/rig/delete-rig';
import { forgetRig } from './recent-rigs';
import { stopSyncForDeletion } from './rig-controls';
import { accountFetch, isAccountError, resolveAccountContext } from './rig-share';

/**
 * "Delete a rig" — `rpc.rig.rigs.delete`, driven by the rigs-rail row
 * menu's "Delete rig…"/"Leave rig…" (`delete-rig-dialog.tsx`).
 *
 * Step order (`deleteRigImpl`, deliberately sequential and NOT
 * parallelized — each step's success is a precondition for the next):
 *
 *   1. Stop syncing this rig LOCALLY (`stopSyncForDeletion`, when a local
 *      path is known) — before touching the relay at all, so a relay
 *      failure below still leaves the rig genuinely not syncing rather
 *      than racing tapd while its fate is undecided.
 *   2. Call the relay (`DELETE .../bindings/:id` for `'delete'`,
 *      `POST .../bindings/:id/leave` for `'leave'`; skipped entirely for
 *      `'local'` — the caller's role wasn't confidently known, so this
 *      never guesses at an owner-only or member-only call). A FAILURE HERE
 *      STOPS THE WHOLE OPERATION: sync stays paused and the `rig_rigs` row
 *      stays intact, so the dialog's error can say "try again" and mean
 *      it — nothing has been forgotten yet.
 *   3. Forget the local `rig_rigs` row (`forgetRig` — a no-op if there
 *      never was one, e.g. a relay-only row with no local copy).
 *   4. Optionally move the folder to the Trash (`shell.trashItem`, never
 *      `rm`). A failure here does NOT fail the overall operation — the rig
 *      is already fully deleted/left/forgotten by this point — it's
 *      reported back as `trashWarning` instead.
 *
 * Dependency-injected (`DeleteRigDeps`) so `deleteRigImpl` itself is pure
 * or­chestration, directly unit-testable with a fake relay/filesystem —
 * see `delete-rig.test.ts`.
 */

export type DeleteRigDeps = {
  stopSync: (path: string) => Promise<Result<unknown, { message: string }>>;
  callRelay: (
    bindingId: string,
    mode: 'delete' | 'leave'
  ) => Promise<Result<{ ok: true }, { kind: DeleteRigFailureKind; message: string }>>;
  forgetLocal: (bindingId: string) => Promise<void>;
  trashFolder: (path: string) => Promise<Result<void, { message: string }>>;
};

export async function deleteRigImpl(
  input: DeleteRigInput,
  deps: DeleteRigDeps
): Promise<Result<DeleteRigSuccess, DeleteRigFailure>> {
  if (input.path) {
    const stopped = await deps.stopSync(input.path);
    if (!stopped.success) {
      return err({ kind: 'localFailure', message: stopped.error.message });
    }
  }

  if (input.mode !== 'local') {
    const relay = await deps.callRelay(input.bindingId, input.mode);
    if (!relay.success) {
      return err({ kind: relay.error.kind, message: relay.error.message });
    }
  }

  await deps.forgetLocal(input.bindingId);

  let trashWarning: string | null = null;
  if (input.trashFolder && input.path) {
    const trashed = await deps.trashFolder(input.path);
    if (!trashed.success) trashWarning = trashed.error.message;
  }

  return ok({ trashWarning });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The real relay call for `'delete'`/`'leave'` — account-plane (no
 * workspace root needed, so this works the same for a local row and a
 * relay-only one): `DELETE /v1/me/bindings/:bindingId` (owner-only) or
 * `POST /v1/me/bindings/:bindingId/leave` (non-owner member). The two
 * relay-specific failure codes (403 `owner_only`, 409 `owner_cannot_leave`)
 * are matched by their exact body shape; anything else — a different 4xx,
 * a 5xx, an unreachable relay — degrades to the generic message.
 */
async function callDeleteOrLeave(
  bindingId: string,
  mode: 'delete' | 'leave'
): Promise<Result<{ ok: true }, { kind: DeleteRigFailureKind; message: string }>> {
  const ctx = await resolveAccountContext();
  if (isAccountError(ctx)) {
    return err({ kind: 'network', message: deriveDeleteRigFailureMessage('network', mode) });
  }

  const suffix =
    mode === 'delete'
      ? `/bindings/${encodeURIComponent(bindingId)}`
      : `/bindings/${encodeURIComponent(bindingId)}/leave`;

  let response: Response;
  try {
    response = await accountFetch(ctx, suffix, {
      method: mode === 'delete' ? 'DELETE' : 'POST',
      ...(mode === 'leave' ? { body: {} } : {}),
    });
  } catch (error) {
    log.warn('rig: delete/leave relay request failed', { bindingId, mode, error: String(error) });
    return err({ kind: 'network', message: deriveDeleteRigFailureMessage('network', mode) });
  }

  if (response.ok) return ok({ ok: true });

  if (response.status === 403) {
    const body = asRecord(await safeJson(response));
    if (body?.reason === 'owner_only') {
      return err({ kind: 'forbiddenOwnerOnly', message: deriveDeleteRigFailureMessage('forbiddenOwnerOnly', mode) });
    }
  }
  if (response.status === 409) {
    const body = asRecord(await safeJson(response));
    if (body?.error === 'owner_cannot_leave') {
      return err({ kind: 'ownerCannotLeave', message: deriveDeleteRigFailureMessage('ownerCannotLeave', mode) });
    }
  }
  log.warn('rig: delete/leave relay call failed', { bindingId, mode, status: response.status });
  return err({ kind: 'other', message: deriveDeleteRigFailureMessage('other', mode) });
}

async function trashFolderImpl(path: string): Promise<Result<void, { message: string }>> {
  try {
    await shell.trashItem(path);
    return ok(undefined);
  } catch (error) {
    return err({
      message: `Could not move the folder to the Trash: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

const realDeps: DeleteRigDeps = {
  stopSync: (path) => stopSyncForDeletion(path),
  callRelay: (bindingId, mode) => callDeleteOrLeave(bindingId, mode),
  forgetLocal: async (bindingId) => {
    await forgetRig(bindingId);
    // Its cached Room and comment threads go with it (lazy: the cache module opens the app DB).
    await (await import('./local-cache-account')).forgetLocalCaches(bindingId);
  },
  trashFolder: (path) => trashFolderImpl(path),
};

export function deleteRig(input: DeleteRigInput): Promise<Result<DeleteRigSuccess, DeleteRigFailure>> {
  return deleteRigImpl(input, realDeps);
}

export type { DeleteRigInput, DeleteRigMode };

export const rigDeleteController = createRPCController({
  /** The rigs-rail row menu's "Delete rig…"/"Leave rig…" — see `delete-rig-dialog.tsx`. */
  delete: (input: DeleteRigInput) => deleteRig(input),
});
