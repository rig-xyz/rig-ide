/**
 * Delete-a-rig round: which bindings THIS session has learned were deleted
 * by someone else — a tiny module-level store, same shape as
 * `session-attention-store.ts` (a `Map` + a listener set + `notify`), so
 * `rigs-rail.tsx` can show "Deleted by <name>" in a row's subtext slot
 * (same slot as "Not a rig anymore"/"Paused") without polling the relay for
 * every local rig on every Home render.
 *
 * Deliberately opportunistic, not proactive: nothing here calls the relay.
 * `App.tsx`'s own binding-deleted detection for the currently-open rig
 * (`rpc.rig.share.members` surfacing `kind: 'bindingDeleted'` — see
 * `shared/rig/rig-share.ts`'s own doc comment on why that's the ONE place
 * a 410 is parsed) is what actually discovers a deletion and calls
 * `markBindingDeleted` below; a rig this session never happened to open (or
 * whose members call never ran) simply won't have an entry here yet, and
 * its row falls back to whatever it would have shown anyway. Never
 * persisted — a relaunch starts empty, same as `session-attention-store`.
 */

export type DeletedRigInfo = {
  deletedAt: string;
  deletedBy: { name: string | null; email: string | null };
};

const deletedByBinding = new Map<string, DeletedRigInfo>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** `App.tsx`'s binding-deleted detection calls this the moment any binding-scoped call surfaces a 410. */
export function markBindingDeleted(bindingId: string, info: DeletedRigInfo): void {
  const prev = deletedByBinding.get(bindingId);
  if (prev && prev.deletedAt === info.deletedAt) return;
  deletedByBinding.set(bindingId, info);
  notify();
}

export function getDeletedRigInfo(bindingId: string): DeletedRigInfo | null {
  return deletedByBinding.get(bindingId) ?? null;
}

/** `rigs-rail.tsx`'s `useSyncExternalStore` subscribe half. */
export function subscribeDeletedRigs(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Test-only: clears the store between test cases. */
export function __resetDeletedRigsForTests(): void {
  deletedByBinding.clear();
  listeners.clear();
}
