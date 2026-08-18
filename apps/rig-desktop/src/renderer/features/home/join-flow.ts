/**
 * Pure helpers for the "set up locally" action (`rpc.rig.join.attach`,
 * used by both Home's "Download" and the invites bell's post-accept "Set
 * up locally") — directory naming only; the actual attach is IO (spawned
 * CLI), covered in `main/rig/join.ts` instead.
 */

/** Mirrors the rig CLI's own `slugifyRigName` (`collab.mjs`) exactly, so the default folder name a person sees here is the same one `rig attach`/`rig join` would derive on its own. */
export function slugifyRigName(name: string | null): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'shared-rig';
}

/** The default local folder for a "Set up locally" join — `~/Rigs/<slug>`, shown as-is (tilde, not expanded) since that's the honest, standard way to display a home-relative path; `main/rig/join.ts` expands it before spawning. */
export function defaultJoinDir(name: string | null): string {
  return `~/Rigs/${slugifyRigName(name)}`;
}
