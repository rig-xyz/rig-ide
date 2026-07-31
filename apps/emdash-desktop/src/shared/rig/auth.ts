/**
 * Rig account sign-in contract, shared by the main-process `rig login` driver
 * (`main/rig/auth.ts`) and the onboarding step that drives it.
 *
 * Signing in is what turns on comments and sync: `rig login` writes an `rpat_`
 * relay PAT to `~/.config/rig/config.json`, which is the only credential the
 * relay's user-plane routes accept.
 */

export type RigAuthStatus = {
  /** True when a relay PAT is already on disk (or supplied via RIG_RELAY_TOKEN). */
  signedIn: boolean;
};

/**
 * Outcome of starting `rig login`.
 *
 * `url` is null when the CLI finished without ever printing one — it was already
 * signed in. The caller should still await completion to learn the exit status.
 */
export type RigLoginStarted = {
  url: string | null;
};

export type RigAuthError =
  | { kind: 'cliMissing'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'cancelled'; message: string };
