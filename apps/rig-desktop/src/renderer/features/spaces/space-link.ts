/**
 * Where a file link in the Room points, as a path inside the space.
 *
 * Links in the Room come from agents: the files a run changed or read (its
 * tool calls report ABSOLUTE paths, on the machine that ran it), and links
 * in its answers (a relative path, the agent's own absolute workspace path,
 * or a `file://` URL). The editor opens files by path relative to the
 * space's folder and refuses anything absolute ("Path must be relative"),
 * so every link is resolved here first:
 *
 *   - relative (`notes/plan.md`, `./plan.md`, `plan.md#intro`) → inside,
 *     unless `..` climbs out of the folder;
 *   - absolute or `file://` under this space's folder → the relative rest
 *     (also when the two only differ by macOS's `/private` prefix, or by
 *     case, which the default macOS disk ignores);
 *   - absolute under ANOTHER person's home that runs through a folder named
 *     like this space's (`/Users/sam/Rig/growth/plan.md` for our
 *     `/Users/me/Rig/growth`): a teammate's agent wrote it, so it's the same
 *     file in their copy of the space — the rest after that folder;
 *   - anything else absolute → outside: refuse, and say so.
 */

export type SpaceLink =
  | { kind: 'inside'; relPath: string }
  | { kind: 'outside'; path: string }
  /** A web or mail link, not a file. */
  | { kind: 'external' };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `a/./b//c/../d` → `a/b/d`; `null` when `..` climbs above the start. */
function normalizeSegments(path: string): string[] | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/** Drops what an agent tacks onto a file path to point inside it: `#heading`, `?query`, `:12` or `:12:3` line/column. */
function stripLocator(path: string): string {
  return path.replace(/[?#].*$/, '').replace(/:\d+(?::\d+)?$/, '');
}

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** `/private/var/…` and `/var/…` are the same folder on macOS (likewise `/tmp`, `/etc`). */
function withoutPrivate(segments: string[]): string[] {
  return segments[0] === 'private' && ['var', 'tmp', 'etc'].includes(segments[1] ?? '') ? segments.slice(1) : segments;
}

/** `['Users', 'sam']` / `['home', 'sam']` — whose home a path is in, or null. */
function homeOf(segments: string[]): string | null {
  return (segments[0] === 'Users' || segments[0] === 'home') && segments[1] ? `${segments[0]}/${segments[1]}` : null;
}

function startsWith(path: string[], prefix: string[], caseInsensitive: boolean): boolean {
  if (path.length <= prefix.length) return false;
  return prefix.every((part, i) =>
    caseInsensitive ? part.toLowerCase() === path[i]!.toLowerCase() : part === path[i]
  );
}

export function resolveSpaceLink(link: string, root: string): SpaceLink {
  let raw = link.trim();
  if (/^file:/i.test(raw)) {
    try {
      raw = decode(new URL(raw).pathname);
    } catch {
      return { kind: 'outside', path: link };
    }
  } else if (SCHEME.test(raw) || raw.startsWith('//')) {
    return { kind: 'external' };
  } else {
    raw = decode(stripLocator(raw));
  }

  if (!raw.startsWith('/')) {
    const segments = normalizeSegments(raw);
    return segments && segments.length > 0 ? { kind: 'inside', relPath: segments.join('/') } : { kind: 'outside', path: link };
  }

  const path = normalizeSegments(raw);
  const base = normalizeSegments(root);
  if (!path || !base || base.length === 0) return { kind: 'outside', path: raw };
  const target = withoutPrivate(path);
  const folder = withoutPrivate(base);

  for (const caseInsensitive of [false, true]) {
    if (startsWith(target, folder, caseInsensitive)) {
      return { kind: 'inside', relPath: target.slice(folder.length).join('/') };
    }
  }

  // A teammate's absolute path: someone else's home, through a folder named like ours.
  const theirHome = homeOf(target);
  const name = folder[folder.length - 1]!;
  if (theirHome && theirHome !== homeOf(folder)) {
    const at = target.indexOf(name, 2);
    if (at !== -1 && at < target.length - 1) return { kind: 'inside', relPath: target.slice(at + 1).join('/') };
  }
  return { kind: 'outside', path: raw };
}
