import { defineEvent } from '../lib/ipc/events';

/**
 * Rig workspace-detection contract, shared by the main-process binding
 * lookup (`main/rig/workspace.ts`) and the renderer's "Open Folder…" flow.
 */

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
  | { bound: false; unsynced: { path: string; name: string | null } | null }
  | { bound: true; bindingId: string; workspaceRoot: string; name: string | null };

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
  if (!facts.pickedHasRigToml) return { bound: false, unsynced: null };
  return { bound: false, unsynced: { path: facts.pickedPath, name: facts.pickedName } };
}

/**
 * A folder path chosen from the native "Open Recent" list (macOS
 * `open-file`) while the app is already running. Carries a plain absolute
 * path, not a `RigWorkspaceDetection` — the renderer runs it through
 * `rig.workspace.detect` itself, the same as the Open Folder… dialog flow.
 */
export const rigOpenRecentChannel = defineEvent<string>('rig:open-recent');
