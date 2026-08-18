/**
 * Create-a-rig contract (Home's "New rig" flow), shared by the main-process
 * CLI driver (`main/rig/create.ts`) and the renderer's create dialog.
 *
 * The CLI is the authority on what a rig IS: `rig init` has no --name flag —
 * the rig's name is derived from its folder's basename (slugged, see
 * `rigSlug`) — so the form's name chooses the FOLDER name, and the slug
 * preview shows exactly what `rig.toml` will say.
 */

export type RigCreateRequest = {
  /** The folder the user picked; the rig is created as a NEW subfolder of it. */
  parentDir: string;
  /** What the user typed — slugged into the folder/rig name (`rigSlug`). */
  name: string;
  /** Go live after init (`rig sync` — mints the relay binding, mirrors to workspace home). */
  sync: boolean;
};

/** `rig sync`'s JSON error envelope, verbatim — e.g. `not_logged_in`, or the 50MB quota message. */
export type RigCreateSyncError = {
  code: string;
  message: string;
};

/**
 * The rig was CREATED (rig.toml exists on disk) — `synced`/`syncError` say
 * what happened after. `syncError` non-null is the honest partial success:
 * created local-only because going live failed; the folder is real and the
 * error is the relay/CLI's own message.
 */
export type RigCreateResult = {
  path: string;
  rigName: string;
  synced: boolean;
  homeUrl: string | null;
  syncError: RigCreateSyncError | null;
};

export type RigCreateError = {
  kind: 'invalidName' | 'exists' | 'cliMissing' | 'initFailed';
  message: string;
  /** The CLI's JSON error code, when its envelope carried one. */
  code?: string;
};

/**
 * The CLI's own naming rule (`createDefaultManifest` in rig's
 * `src/manifest.mjs`): lowercase, runs of anything outside [a-z0-9._-]
 * collapse to one hyphen — tightened here to strip ALL leading/trailing
 * hyphens (the CLI strips one) so the result is a fixpoint: running the
 * CLI's rule on a folder named by this slug changes nothing, and the
 * preview always matches what `rig.toml` will actually say.
 */
export function rigSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Null when the name works; otherwise the message the form shows under the field. */
export function validateRigName(name: string): string | null {
  if (!name.trim()) return 'Give the rig a name.';
  if (!rigSlug(name)) return 'The name needs at least one letter or number.';
  return null;
}
