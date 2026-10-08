import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';
import { parseRigFileUrl, RIG_FILE_SCHEME } from '@shared/spaces/rig-file';
import { secretReason } from '../attachments/rules';

/**
 * `rig-file://<binding id>/<path>`: a space's files served to the page panel
 * from this Mac's synced copy, so an agent's `index.html` opens like any web
 * page with its relative scripts, styles and images. No server, no port.
 *
 * Read only, and only inside the space's folder: the path can't climb out
 * (`..` is refused when the link is parsed), a symlink that leads outside
 * is refused once resolved, and so are hidden files and folders (`.rig/`
 * holds the sync token, `.env` and the like), local-only files and files
 * named like secrets. A file inside a different rig nested in the folder
 * isn't this space's. Only spaces bound on this Mac resolve.
 *
 * A page from somewhere else can't pull these files in. Chromium hands a
 * protocol handler no Referer or Origin, so the gate is the session's
 * request hook (`rigFileRequestAllowed`): a space's file loads into a page
 * only when that page is the same space's own. A request that does say it
 * comes from another origin is refused here too, and no CORS header is ever
 * sent. Pure node here, so tests run it on a real folder;
 * `rig-file-session.ts` hooks it into Electron.
 */

/** Registered once, before the app is ready (`app/protocol.ts`). */
export const RIG_FILE_PRIVILEGES = {
  scheme: RIG_FILE_SCHEME,
  privileges: {
    // Relative links, an origin of its own per space, and secure-context APIs.
    standard: true,
    secure: true,
    // fetch() and ES modules, which are fetched in CORS mode even same-origin.
    supportFetchAPI: true,
    corsEnabled: true,
    // Audio and video.
    stream: true,
  },
} as const;

/** Bigger files aren't served (a page's assets are far smaller). */
export const RIG_FILE_MAX_BYTES = 100 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wasm': 'application/wasm',
};

/** The Content-Type a file is served with, from its extension. */
export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface RigFileDeps {
  /** The space's folder on this Mac, or null when it isn't bound here. */
  rootFor(bindingId: string): Promise<string | null>;
  /** The binding a folder belongs to, walking up; null when none. */
  bindingAt(dir: string): string | null;
}

export type RigFileResolved = { ok: true; absPath: string } | { ok: false; status: 403 | 404 };

/** A name that's never served: hidden, local-only, or named like a secret. */
function privateName(name: string): boolean {
  return name.startsWith('.') || /\.local(\.|$)/i.test(name) || secretReason(name, null) !== null;
}

/**
 * The file a link's path points at in the space's folder, or why not. A
 * folder serves its `index.html`.
 */
export async function resolveRigFile(
  deps: RigFileDeps,
  bindingId: string,
  relPath: string
): Promise<RigFileResolved> {
  const root = await deps.rootFor(bindingId);
  if (!root) return { ok: false, status: 404 };
  const parts = relPath.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.' || part.includes('\\') || part.includes('\0'))) {
    return { ok: false, status: 403 };
  }
  if (parts.some(privateName)) return { ok: false, status: 403 };

  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    real = await realpath(join(realRoot, ...parts));
  } catch {
    return { ok: false, status: 404 };
  }
  // A symlink that leads outside the folder, or to a private file inside it.
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, status: 403 };
  if (real.slice(realRoot.length).split(sep).filter(Boolean).some(privateName)) return { ok: false, status: 403 };

  let info;
  try {
    info = await stat(real);
  } catch {
    return { ok: false, status: 404 };
  }
  if (info.isDirectory()) {
    return parts.length > 0 && parts.at(-1) === 'index.html'
      ? { ok: false, status: 404 }
      : resolveRigFile(deps, bindingId, [...parts, 'index.html'].join('/'));
  }
  if (!info.isFile()) return { ok: false, status: 404 };
  // A different rig nested inside the folder isn't this space.
  if (deps.bindingAt(dirname(real))?.toLowerCase() !== bindingId.toLowerCase()) return { ok: false, status: 403 };
  return { ok: true, absPath: real };
}

/** What a space file page's outgoing web requests say they came from when Chromium sends nothing. */
export const RIG_FILE_FALLBACK_REFERER = 'https://userig.xyz/';

/**
 * A page served from `rig-file://` sends no Referer to the web (Chromium
 * sends none from a custom scheme), and some servers refuse a request
 * without one: OpenStreetMap's tile servers answer 403 to every Leaflet
 * tile. So an http(s) request with no Referer gets Rig's own. Requests to
 * `rig-file://` itself and ones that already carry a Referer are left as
 * they are.
 */
export function addFallbackReferer(url: string, headers: Record<string, string>): void {
  if (!/^https?:/i.test(url)) return;
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'referer')) return;
  headers.Referer = RIG_FILE_FALLBACK_REFERER;
}

/**
 * Whether a request for a space's file may load, from what asks for it: a
 * page opened on its own (the panel, an agent's tab, a link followed inside
 * the space) always may; anything a page pulls in, scripts, styles, images,
 * frames and fetches, only from a page of the same space. `requester` is
 * the URL of the frame asking, null when none.
 */
export function rigFileRequestAllowed(url: string, resourceType: string, requester: string | null): boolean {
  const target = parseRigFileUrl(url);
  if (!target) return false;
  if (resourceType === 'mainFrame') return true;
  const from = requester ? parseRigFileUrl(requester) : null;
  return from !== null && from.bindingId === target.bindingId;
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${RIG_FILE_SCHEME}:` ? `${RIG_FILE_SCHEME}://${parsed.host}` : parsed.origin;
  } catch {
    return null;
  }
}

/** Whether the request comes from this space's own pages, or from nowhere (the panel opening it). */
function fromOwnSpace(request: Request, bindingId: string): boolean {
  const own = `${RIG_FILE_SCHEME}://${bindingId.toLowerCase()}`;
  const origin = request.headers.get('origin');
  if (origin) return origin.toLowerCase() === own;
  const referer = request.headers.get('referer');
  if (referer) return originOf(referer)?.toLowerCase() === own;
  return true;
}

function refuse(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

/** The answer to one `rig-file://` request. */
export async function rigFileResponse(request: Request, deps: RigFileDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405);
  const link = parseRigFileUrl(request.url);
  if (!link) return refuse(403);
  if (!fromOwnSpace(request, link.bindingId)) return refuse(403);
  const resolved = await resolveRigFile(deps, link.bindingId, link.relPath);
  if (!resolved.ok) return refuse(resolved.status);
  let body: Buffer;
  try {
    if ((await stat(resolved.absPath)).size > RIG_FILE_MAX_BYTES) return refuse(413);
    body = await readFile(resolved.absPath);
  } catch {
    return refuse(404);
  }
  const headers = {
    'content-type': mimeTypeFor(basename(resolved.absPath)),
    'content-length': String(body.length),
    // Always the file as it is now: an agent may have just changed it.
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers });
}
