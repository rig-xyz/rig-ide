/**
 * Conflict copies: when a local edit loses a clash, tapd keeps it beside the
 * file as `<stem>.conflict-from.<device>.<chg_id><ext>`. They never sync
 * (`*.conflict-from.*` is ignored) and they hold the person's own work, so
 * until there is a real way to resolve a clash the Files list folds them
 * into the file they came from instead of listing each one. A copy whose
 * file is gone stays visible: hiding it would hide the only copy of that
 * work.
 */

/** The same shape tap matches (`stem`, device, `chg_<n>`, optional extension). */
const CONFLICT_COPY = /^(.*)\.conflict-from\.[^.]+\.(chg_\d+)(\.[^.]+)?$/;

/** The path of the file a conflict copy came from, or null when `path` isn't one. */
export function conflictCopyOriginal(path: string): string | null {
  const match = CONFLICT_COPY.exec(path);
  if (!match || !match[1] || match[1].endsWith('/')) return null;
  return `${match[1]}${match[3] ?? ''}`;
}

/**
 * Splits `paths` into what a file list shows and the copies folded into
 * each shown file. A copy is folded only when its file is in `paths`.
 * Order is kept: `visible` and each file's copies are in `paths` order.
 */
export function groupConflictCopies(paths: readonly string[]): {
  visible: string[];
  copiesByOriginal: Map<string, string[]>;
} {
  const present = new Set(paths);
  const visible: string[] = [];
  const copiesByOriginal = new Map<string, string[]>();
  for (const path of paths) {
    const original = conflictCopyOriginal(path);
    if (original === null || !present.has(original)) {
      visible.push(path);
      continue;
    }
    const copies = copiesByOriginal.get(original);
    if (copies) copies.push(path);
    else copiesByOriginal.set(original, [path]);
  }
  return { visible, copiesByOriginal };
}

/** "9 of your versions to review", "1 of your versions to review". */
export function conflictCopiesLabel(count: number): string {
  return `${count} of your versions to review`;
}
