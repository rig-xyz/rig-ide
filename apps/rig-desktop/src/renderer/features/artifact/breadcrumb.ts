/**
 * Pure path → breadcrumb segments for the artifact panel's header: just
 * "folder / folder / filename.md". Folder segments pop to the file
 * navigator; the filename is the current position, not a link.
 *
 * Header-dedup round, take 3: no root segment at all — neither the rig name
 * (the topbar's mini-breadcrumb carries it) nor a Home crumb (the topbar's
 * house button owns up-navigation). A file at the rig root is a single
 * filename segment; the way back to the navigator is the header's own Back
 * button.
 *
 * Folder segments carry the folder's relPath so the navigator can actually
 * reveal it (`FileTree`'s `revealPath` prop — expand ancestors, scroll the
 * target into view, brief highlight) rather than just landing on the
 * unfiltered root.
 */

export type BreadcrumbSegment =
  | { label: string; kind: 'folder'; relPath: string }
  | { label: string; kind: 'file' };

export function breadcrumbSegments(root: string, path: string): BreadcrumbSegment[] {
  const rel = path.startsWith(root) ? path.slice(root.length).replace(/^\/+/, '') : path;
  const parts = rel.split('/').filter((part) => part.length > 0);
  const folders = parts.slice(0, -1);
  const filename = parts[parts.length - 1] ?? rel;

  const folderSegments: BreadcrumbSegment[] = folders.map((label, index) => ({
    label,
    kind: 'folder',
    relPath: folders.slice(0, index + 1).join('/'),
  }));

  return [...folderSegments, { label: filename, kind: 'file' }];
}
