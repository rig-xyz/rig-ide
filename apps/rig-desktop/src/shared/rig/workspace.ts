import { defineEvent } from '../lib/ipc/events';

/**
 * Rig workspace-detection contract, shared by the main-process binding
 * lookup (`main/rig/workspace.ts`) and the renderer's "Open Folder…" flow.
 */

/** How a rig came to be opened — the `rig_opened` telemetry event's `source`. */
export type RigOpenSource = 'recent' | 'create' | 'join' | 'deeplink' | 'other';

/**
 * What the shell shows after "Open Folder…": whether the picked directory
 * (or one of its ancestors) is bound to a rig, and if so, the rig's name.
 *
 * `name` is read straight from the workspace's own `rig.toml` (`[rig].name`)
 * rather than the relay, so this works offline and without sign-in — the same
 * honesty rule as the binding check itself: no name is shown unless it is
 * really there.
 *
 * Loose-ends round: `unsynced` distinguishes a LOCAL-ONLY rig from a plain
 * non-rig folder — the CLI's own rule (`requireWorkspace`/`readBinding` in
 * rig's collab.mjs): `rig.toml` present in the picked folder itself, with no
 * `.rig/tap-binding.local.json` beside it. The shell offers to turn sync on
 * (which is what makes the workspace openable here) instead of dead-ending
 * at "not a rig". Null = genuinely not a rig; that path is unchanged.
 */
export type RigWorkspaceDetection =
  | {
      bound: false;
      unsynced: { path: string; name: string | null } | null;
      /**
       * Accounts & rigs round (onboarding-flow-spec.md, "Accounts & rigs"):
       * set when `folderPath` IS a bound, relay-synced rig, but its
       * `rig_rigs` row belongs to a different, confidently-known account
       * than whoever is signed in right now (see `isForeignAccountRow`).
       * `detect` stops short of recording the open or registering the file
       * root when this is set — opening it under the wrong identity would
       * just fail relay-side with confusing errors, so the renderer shows
       * an honest card instead. Mutually exclusive with `unsynced` — a rig
       * can't be both un-synced (no binding at all) and
       * foreign-account-bound.
       */
      foreignAccount: { path: string; name: string | null } | null;
    }
  | {
      bound: true;
      bindingId: string;
      /** Opaque main-process capability used by renderer filesystem calls. */
      rootId: string;
      workspaceRoot: string;
      name: string | null;
    };

/**
 * The unbound half of detection, pure (loose-ends round). Mirrors the CLI's
 * own facts exactly (`requireWorkspace`/`readBinding` in rig's collab.mjs):
 * a LOCAL-ONLY rig is `rig.toml` in the picked folder ITSELF — deliberately
 * no ancestor walk, since `rig sync` would run in that folder and a
 * parent's manifest is a different workspace — and no binding anywhere the
 * binding walk looks. A folder without its own rig.toml stays the plain
 * "not a rig" outcome. Lives here (not `main/rig/workspace.ts`) so it stays
 * electron-free and directly unit-testable.
 */
export function deriveUnboundDetection(facts: {
  pickedPath: string;
  pickedHasRigToml: boolean;
  pickedName: string | null;
}): Extract<RigWorkspaceDetection, { bound: false }> {
  if (!facts.pickedHasRigToml) return { bound: false, unsynced: null, foreignAccount: null };
  return {
    bound: false,
    unsynced: { path: facts.pickedPath, name: facts.pickedName },
    foreignAccount: null,
  };
}

/**
 * Accounts & rigs round: whether the LOCAL `rig_rigs` row's own recorded
 * account — the identity that bound or last opened this rig, see
 * `recent-rigs.ts`'s own upsert comment — is confidently a DIFFERENT one
 * from whoever is signed in right now. `existingAccountId` is `undefined`
 * when there's no local row at all (nothing recorded yet — never foreign,
 * `detect` proceeds to create one) and `null` when a row exists but no
 * account was ever stamped on it (a legacy row, or one written while
 * signed out — shown to everyone until an open while signed in backfills
 * it, per the spec). `current` is `main/rig/account.ts`'s own three-state
 * read of "who's signed in right now" — `'unknown'` (couldn't reach the
 * relay to check) always resolves to `false`: a transient relay hiccup
 * must never block someone from opening their own already-synced rig, the
 * same fail-open rule `resolveLocalPathsImpl` and `recordRigOpened`'s own
 * best-effort callers already follow for network trouble. `'signedOut'`
 * DOES count as foreign against any non-null `existingAccountId` — signing
 * back in as whichever account owns the row is exactly the honest card's
 * point.
 */
export function isForeignAccountRow(
  existingAccountId: string | null | undefined,
  current: { status: 'signedOut' } | { status: 'known'; id: string } | { status: 'unknown' }
): boolean {
  if (!existingAccountId) return false;
  if (current.status === 'unknown') return false;
  const currentId = current.status === 'known' ? current.id : null;
  return currentId !== existingAccountId;
}

/**
 * A folder path chosen from the native "Open Recent" list (macOS
 * `open-file`) while the app is already running. Carries a plain absolute
 * path, not a `RigWorkspaceDetection` — the renderer runs it through
 * `rig.workspace.detect` itself, the same as the Open Folder… dialog flow.
 */
export const rigOpenRecentChannel = defineEvent<string>('rig:open-recent');
