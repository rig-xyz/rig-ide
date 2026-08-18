/**
 * The Add menu's "New file" naming — first free `untitled-N.md` at the rig
 * root. `existingRootFileNames` is the root-level `RigFileNode[]`'s own file
 * names (not the whole recursive tree — a same-named file inside a
 * subfolder doesn't collide with a new file written into the root).
 */
export function nextUntitledFileName(existingRootFileNames: ReadonlySet<string> | readonly string[]): string {
  const taken = existingRootFileNames instanceof Set ? existingRootFileNames : new Set(existingRootFileNames);
  let n = 1;
  while (taken.has(`untitled-${n}.md`)) n++;
  return `untitled-${n}.md`;
}
