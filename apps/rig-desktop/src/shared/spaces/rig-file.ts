/**
 * Links to a file in a space, as a page: `rig-file://<binding id>/<path>`.
 * Each Mac resolves one to its own synced copy of that space's folder
 * (`main/rig/pages/rig-file-protocol.ts`), so the same link works for every
 * member and relative scripts, styles and images load next to it. No server,
 * no port.
 */

export const RIG_FILE_SCHEME = 'rig-file';

/** `notes/a b.html` → `notes/a%20b.html`: each segment encoded, the slashes kept. */
function encodePath(relPath: string): string {
  return relPath
    .split('/')
    .filter((part) => part !== '')
    .map(encodeURIComponent)
    .join('/');
}

/** The link to a file in a space: `rig-file://bnd_x/site/index.html`. */
export function rigFileUrl(bindingId: string, relPath: string): string {
  return `${RIG_FILE_SCHEME}://${bindingId.toLowerCase()}/${encodePath(relPath)}`;
}

export function isRigFileUrl(url: string): boolean {
  return url.toLowerCase().startsWith(`${RIG_FILE_SCHEME}://`);
}

/**
 * The space and path a `rig-file://` link points at, or null when it isn't
 * one or its path is unsafe: a `..` or `.` step, a backslash, a NUL, or
 * bad percent-encoding. The fragment and query are dropped. A link to the
 * space itself (no path) gives an empty `relPath`.
 */
export function parseRigFileUrl(url: string): { bindingId: string; relPath: string } | null {
  if (!isRigFileUrl(url)) return null;
  const rest = url.slice(RIG_FILE_SCHEME.length + 3).replace(/[?#].*$/, '');
  const slash = rest.indexOf('/');
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(host)) return null;
  const segments: string[] = [];
  for (const raw of (slash === -1 ? '' : rest.slice(slash + 1)).split('/')) {
    if (raw === '') continue;
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0')) return null;
    segments.push(part);
  }
  return { bindingId: host, relPath: segments.join('/') };
}

/** An html file, shown as a page rather than as text. */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path.replace(/[?#].*$/, ''));
}
