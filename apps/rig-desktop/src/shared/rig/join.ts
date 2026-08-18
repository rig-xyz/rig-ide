/**
 * Self-service local setup for a relay-only binding — round H2's Home
 * screen "Set up locally" action (the S3 invited-cofounder case: signed in,
 * a member of a rig, never opened it on this device), now generalized to
 * every member role.
 *
 * Investigated (H2): `rig join` (the CLI) only ever accepts a genuine
 * invite token/URL — it has no "I'm already a member, just give me a local
 * checkout" mode, and self-minting one required an `owner`-only relay
 * endpoint, so `editor`/`viewer` bindings had no automatable path.
 *
 * Superseded (round: rig attach): the rig CLI now ships `rig attach
 * <bindingId>`, which mints a device directly off
 * `POST /v1/me/bindings/:bindingId/devices` — a member-gated endpoint (any
 * of owner/editor/viewer, not owner-only) that needs no invite secret at
 * all. `main/rig/join.ts` drives it exactly like `rig join <url>` before
 * it: spawn, parse `--json`, done. One door for every role.
 */

export type RigJoinResult = {
  /** The folder the CLI created and bound. */
  localPath: string;
  rigName: string | null;
  /** Whether the sync daemon actually started syncing there. */
  syncing: boolean;
};

/**
 * `rig attach <bindingId> --dir <targetDir> --json`'s failure modes, as
 * classified from the CLI's `--json` error envelope
 * (`{ protocolVersion, error: { code, message } }`, emitted by `bin/rig.mjs`
 * for every command) or, failing that, its exit output. See
 * `main/rig/join.ts`'s `classifyAttachFailure`.
 */
export type RigAttachError =
  | { kind: 'notSignedIn'; message: string }
  | { kind: 'notAMember'; message: string }
  /** The installed rig CLI predates `attach` — the one honest fallback (no owner-only re-fallback to the old invite flow). */
  | { kind: 'outdatedCli'; message: string }
  | { kind: 'cliMissing'; message: string }
  | { kind: 'attachFailed'; message: string };

/**
 * "Locate…" (correction round — the honest, user-consented replacement for
 * the deleted filesystem scan): the user picks one directory they already
 * have, and this verifies it's genuinely the binding a Home row is for
 * before anything gets recorded. See `main/rig/join.ts`'s `deriveLocateOutcome`.
 */
export type RigLocateError = { kind: 'notFound'; message: string } | { kind: 'mismatch'; message: string };
