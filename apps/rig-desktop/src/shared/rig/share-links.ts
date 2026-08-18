/**
 * Share-link contract, shared by the main-process relay client
 * (`main/rig/share-links.ts`) and the artifact view's Share popover.
 *
 * Mirrors the tap relay's `share_links` shape (`docs/share-links-spec.md` in
 * that repo) — Google-Docs-style public links to a single artifact. Same
 * two-plane split as everywhere else in this app talks to the relay: the
 * management endpoints here are user-authed (the `rpat_` PAT, editor+ role);
 * the public token plane (`/a/:token`) needs no auth at all and this app
 * never calls it — the minted URL is handed to someone else to open.
 */

export type SharePermission = 'read' | 'comment';

/** One `share_links` row — never carries the raw token/URL (see `RigShareLinkMinted`). */
export type RigShareLink = {
  id: string;
  bindingId: string;
  relPath: string;
  permission: SharePermission;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
};

/**
 * A freshly minted link's one-time result. The relay returns the raw
 * secret/URL only in this response — `list` never re-sends it (the token is
 * a bearer capability, not something the relay can safely hand back later)
 * — so this is the only moment the UI ever has a copyable URL to show.
 */
export type RigShareLinkMinted = {
  shareLink: RigShareLink;
  url: string;
};

/**
 * Structured failure, shaped like `RigCommentsError` (same file/relPath
 * resolution, same trust gate, same PAT) but with its own resource-specific
 * cases: `forbidden` (a member, but only `viewer` role — share-link routes
 * need editor+) and `notFound` (the target path has no manifest entry yet,
 * or a revoke's `id` doesn't exist) don't map cleanly onto comments' error
 * kinds, so this is its own type rather than reusing `RigCommentsError`.
 */
export type RigShareLinkError =
  | { kind: 'notBound'; message: string }
  | { kind: 'unauthenticated'; message: string }
  | { kind: 'untrustedRelay'; host: string; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'notFound'; message: string }
  | { kind: 'relay'; status?: number; message: string };
