import type { Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { SPACE_NAME_MAX } from './spaces/rig-tools';

/**
 * Keeps the relay's binding name (what pulse and the web show) in step with
 * the rig's own `rig.toml` name (what this app and every member's synced
 * copy show).
 *
 * Two ways a name changes:
 *   1. The Rename dialog / `rig_rename_space` tool (`renameRig`): writes
 *      rig.toml, then `pushRename` PATCHes the relay straight away.
 *   2. Anything else edits rig.toml (an agent editing the file, a rename
 *      synced down from another member's machine): `reconcile` notices it
 *      when Home lists the relay's bindings (`workspaces()`), and `schedule`
 *      runs the same pass (debounced) when the open rig's rig.toml name
 *      changes under the file watcher.
 *
 * `reconcile` only pushes when all of these hold (`nameToPush`):
 *   - the caller is an owner or editor on the relay (the relay would 403 a viewer);
 *   - rig.toml's name differs from the relay's;
 *   - rig.toml was written AFTER the relay's name last changed (its
 *     `updatedAt`). This is what stops members fighting: if A renames and
 *     A's app updates the relay, B's app (whose rig.toml hasn't synced yet)
 *     sees an older rig.toml than the relay's change and leaves it alone;
 *     once the new rig.toml lands, B sees the names already match.
 *     Concurrent renames converge on whatever rig.toml tapd settles on.
 * and each binding gets at most one attempt per name per app run, so a
 * relay that refuses (an old relay without renames) is asked once, not on
 * every Home refresh.
 */

/** What the relay does to a name: whitespace runs (newlines too) become one space, ends trimmed. */
export function normalizeRigName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

export type RelayBindingName = { id: string; name: string; role: string; updatedAt?: string };
export type LocalRigName = { name: string; mtimeMs: number };
export type RelayNameFailure = { kind: string; message: string; status?: number; code?: string };

/** The name to push to the relay for this binding, or null to leave it alone (see the header for the rules). */
export function nameToPush(local: LocalRigName | null, relay: RelayBindingName): string | null {
  if (!local) return null;
  if (relay.role !== 'owner' && relay.role !== 'editor') return null;
  const name = normalizeRigName(local.name);
  if (!name || name.length > SPACE_NAME_MAX) return null;
  if (name === normalizeRigName(relay.name)) return null;
  const relayChangedAt = relay.updatedAt ? Date.parse(relay.updatedAt) : Number.NaN;
  if (Number.isFinite(relayChangedAt) && local.mtimeMs <= relayChangedAt) return null;
  return name;
}

/** The quiet warning for a rename that saved locally but not on the relay, or null when there's nothing to tell the person. */
export function renameWarning(error: RelayNameFailure): string | null {
  // Signed out, an untrusted relay, an expired sign-in: a local rename, as before.
  if (error.kind !== 'relay') return null;
  // A relay from before renames existed ignores `name` and answers this; expected until it's deployed.
  if (error.status === 400 && error.code === 'no_changes') return null;
  return `Renamed, but Home summaries may show the old name for now. ${error.message}`;
}

export type RelayNameSyncDeps = {
  patchName(bindingId: string, name: string): Promise<Result<void, RelayNameFailure>>;
  /** The relay's bindings for the signed-in account, or null when they can't be read right now. */
  listBindings(): Promise<RelayBindingName[] | null>;
  /** Local folders for these bindings (absent when there's no local copy). */
  localPaths(bindingIds: string[]): Promise<Record<string, string>>;
  readLocal(path: string): Promise<LocalRigName | null>;
  /** A `reconcile` push landed: refresh whatever shows the name. */
  onPushed(bindingId: string, name: string): void;
  debounceMs?: number;
};

export function createRelayNameSync(deps: RelayNameSyncDeps) {
  /** bindingId → the last name pushed (or tried) this run. */
  const attempted = new Map<string, string>();
  /** open rig root → the rig.toml name last seen there. */
  const seen = new Map<string, string | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function push(bindingId: string, name: string): Promise<Result<void, RelayNameFailure>> {
    attempted.set(bindingId, name);
    const result = await deps.patchName(bindingId, name);
    if (!result.success) {
      log.info('rig: could not update the name on the relay', {
        bindingId,
        status: result.error.status,
        error: result.error.message,
      });
    }
    return result;
  }

  /** Pushes every local rig.toml name the relay should take (see `nameToPush`). */
  async function reconcile(bindings: readonly RelayBindingName[]): Promise<void> {
    const editable = bindings.filter((b) => b.role === 'owner' || b.role === 'editor');
    if (editable.length === 0) return;
    const paths = await deps.localPaths(editable.map((b) => b.id));
    for (const binding of editable) {
      const path = paths[binding.id];
      if (!path) continue;
      const name = nameToPush(await deps.readLocal(path), binding);
      if (!name || attempted.get(binding.id) === name) continue;
      const result = await push(binding.id, name);
      if (result.success) deps.onPushed(binding.id, name);
    }
  }

  return {
    reconcile,

    /** After an explicit rename: always asks the relay. Returns the warning to show, or null. */
    async pushRename(bindingId: string, name: string): Promise<string | null> {
      const result = await push(bindingId, normalizeRigName(name));
      return result.success ? null : renameWarning(result.error);
    },

    /** The open rig's watcher read `name` from `root`'s rig.toml: when it's new or changed, reconcile soon. */
    noteLocalName(root: string, name: string | null): void {
      if (seen.has(root) && seen.get(root) === name) return;
      seen.set(root, name);
      if (name === null) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void deps
          .listBindings()
          .then((bindings) => (bindings ? reconcile(bindings) : undefined))
          .catch((error: unknown) => log.warn('rig: relay name sync failed', { error: String(error) }));
      }, deps.debounceMs ?? 2_000);
    },
  };
}

export type RelayNameSync = ReturnType<typeof createRelayNameSync>;
