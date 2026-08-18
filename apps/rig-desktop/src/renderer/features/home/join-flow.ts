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

/**
 * Where a rig actually materializes given the folder a person PICKED.
 *
 * The native directory picker returns the folder they selected, and a rig
 * must never be unpacked directly into it: someone choosing `~/Code`
 * means "put it in here", not "turn ~/Code itself into this rig". Passing
 * the picked path through verbatim did exactly that — it bound `~/Code`
 * as a rig workspace and pointed the sync daemon at every project inside
 * it (it died on EMFILE watching them, which is the only reason nothing
 * was uploaded). The rig always gets its own folder, named for itself.
 */
export function joinTargetDir(pickedDir: string, name: string | null): string {
  const parent = pickedDir.replace(/\/+$/, '');
  const slug = slugifyRigName(name);
  // Already inside a folder of that name (they navigated into it, or
  // picked a folder they made for it) — don't nest a second copy.
  return parent.split('/').pop() === slug ? parent : `${parent}/${slug}`;
}
