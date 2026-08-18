/**
 * Rig account contract, shared by the main-process account client
 * (`main/rig/account.ts`) and the renderer surfaces that show who is
 * signed in and which workspaces they're a member of (the sidebar identity
 * chip, Settings → Workspaces).
 *
 * Account-scoped: unlike `comments.ts`, there is no workspace/binding
 * involved in resolving these — just the signed-in user's PAT.
 */

export type RigUser = {
  id: string;
  clerkUserId: string;
  /** Nullable on the relay itself: accounts created via Clerk can have none. */
  email: string | null;
  /**
   * Added to the relay's `GET /v1/me` recently — absent on relays that
   * predate it. Degrades to null rather than being dropped or throwing.
   */
  name: string | null;
  /** Same story as `name`: possibly absent on older relays, degrades to null. */
  avatarUrl: string | null;
  createdAt: string;
};

/** One row of `GET /v1/me/bindings` — a rig the signed-in user is a member of. */
export type RigWorkspaceBinding = {
  id: string;
  name: string;
  role: string;
  /**
   * Most recent time the caller's OWN device synced this binding; null if
   * the caller has never synced it from this account.
   */
  lastSyncedAt: string | null;
  /**
   * When the binding itself was created (`rig_bindings.created_at` on the
   * relay — `tap`'s `listBindingsForUser`, not something this app derives).
   * The Home screen's one human-meaningful discriminator for two rows that
   * happen to share a name (correction round — replaces a bindingId hex
   * suffix nobody could read anything into).
   */
  createdAt: string;
  /**
   * Host of the relay this binding was read from. `GET /v1/me/bindings`
   * itself carries no per-binding relay URL — every binding it returns lives
   * on the one relay the request was made to, so this is that relay's host,
   * not a field the relay actually sends.
   */
  relayHost: string;
};

export type RigAccountError =
  | { kind: 'notSignedIn'; message: string }
  | { kind: 'untrustedRelay'; host: string; message: string }
  | { kind: 'relay'; status?: number; message: string };
