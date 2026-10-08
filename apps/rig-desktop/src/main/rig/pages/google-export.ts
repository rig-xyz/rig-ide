import { net, type Session } from 'electron';

/**
 * Google Docs, Sheets and Slides draw their text on a canvas, so reading the
 * page's DOM gets the title and little else. For those links `rig_browser_read`
 * asks Google for the file's own text export instead, in the hidden tab's
 * session (the pages browser profile), so it's exactly what the person's
 * sign-in there can see.
 *
 * Nothing here signs anyone in: it runs only after the tab loaded the file
 * without hitting a sign-in wall, only uses cookies the profile already has,
 * and stops at any redirect off Google's document hosts (accounts.google.com
 * above all). When the export can't be had, the tool reads the page as
 * rendered and says why.
 */

export const EXPORT_MAX_BYTES = 1_000_000;
export const EXPORT_TIMEOUT_MS = 15_000;

type Kind = 'document' | 'spreadsheets' | 'presentation';
const LABEL: Record<Kind, string> = { document: 'Google Docs', spreadsheets: 'Google Sheets', presentation: 'Google Slides' };

export interface GoogleExportTarget {
  kind: Kind;
  id: string;
  /** "Google Docs", "Google Sheets", "Google Slides". */
  label: string;
  /** Export links to try, in order. */
  urls: string[];
}

/** docs.google.com/<kind>[/u/<n>]/d/<id>/…; not a published (`/d/e/…`) copy. */
const EDITOR_PATH = /^\/(document|spreadsheets|presentation)(\/u\/\d+)?\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/;

function editorFile(url: string): { kind: Kind; id: string; base: string; parsed: URL } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com') return null;
  const m = EDITOR_PATH.exec(parsed.pathname);
  if (!m) return null;
  const kind = m[1] as Kind;
  return { kind, id: m[3]!, base: `https://docs.google.com/${kind}${m[2] ?? ''}/d/${m[3]}`, parsed };
}

function gidOf(parsed: URL): string | null {
  const gid = parsed.searchParams.get('gid') ?? new URLSearchParams(parsed.hash.slice(1)).get('gid');
  return gid && /^\d+$/.test(gid) ? gid : null;
}

/**
 * The export links for a Google editor link, or null for any other page.
 * A sheet's tab (`gid`) comes from the link, else from where the tab
 * landed (`loadedUrl`, the same file only); none means the first sheet.
 */
export function googleExportTarget(url: string, loadedUrl?: string): GoogleExportTarget | null {
  const file = editorFile(url);
  if (!file) return null;
  const { kind, id, base } = file;
  const urls =
    kind === 'document'
      ? [`${base}/export?format=md`, `${base}/export?format=txt`]
      : kind === 'presentation'
        ? [`${base}/export/txt`]
        : (() => {
            const loaded = loadedUrl ? editorFile(loadedUrl) : null;
            const gid = gidOf(file.parsed) ?? (loaded && loaded.kind === kind && loaded.id === id ? gidOf(loaded.parsed) : null);
            return [`${base}/export?format=csv${gid ? `&gid=${gid}` : ''}`];
          })();
  return { kind, id, label: LABEL[kind], urls };
}

/** Whether two links open the same Google file. */
export function sameGoogleFile(a: string, b: string): boolean {
  const x = editorFile(a);
  const y = editorFile(b);
  return !!x && !!y && x.kind === y.kind && x.id === y.id;
}

/** Where an export may be redirected: Google's document hosts, over https. Never a sign-in page. */
export function exportRedirectAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'docs.google.com' || u.hostname.endsWith('.googleusercontent.com'));
  } catch {
    return false;
  }
}

export type ExportResponse =
  | { kind: 'response'; status: number; contentType: string; body: Buffer; truncated: boolean }
  /** A redirect that wasn't followed (see `exportRedirectAllowed`). */
  | { kind: 'redirect'; to: string }
  | { kind: 'error'; message: string };

/** One GET, following only allowed redirects, reading at most `maxBytes` of the body. */
export type ExportGet = (url: string, opts: { maxBytes: number; signal: AbortSignal }) => Promise<ExportResponse>;

export type GoogleExportResult =
  | { ok: true; label: string; text: string; truncated: boolean }
  | { ok: false; label: string; why: string };

/** The file's text, trying each export link in turn; stops at a sign-in, a refusal or the time limit. */
export async function readGoogleExport(
  target: GoogleExportTarget,
  get: ExportGet,
  { timeoutMs = EXPORT_TIMEOUT_MS, maxBytes = EXPORT_MAX_BYTES }: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<GoogleExportResult> {
  const fail = (why: string): GoogleExportResult => ({ ok: false, label: target.label, why });
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<ExportResponse>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve({ kind: 'error', message: 'timed out' });
    }, timeoutMs);
  });
  try {
    let why = 'no export link answered';
    for (const url of target.urls) {
      const res = await Promise.race([get(url, { maxBytes, signal: ctl.signal }), timedOut]);
      if (ctl.signal.aborted) return fail(`the export took longer than ${Math.round(timeoutMs / 1000)}s`);
      if (res.kind === 'redirect') {
        const host = hostOf(res.to);
        return fail(
          host === 'accounts.google.com'
            ? 'Google sent the download to its sign-in page, so this account in rig may not be signed in for it'
            : `Google sent the download to ${host ?? 'another site'}, which rig doesn't follow`
        );
      }
      if (res.kind === 'error') return fail(`the export failed (${res.message})`);
      if (res.status === 401 || res.status === 403) {
        return fail(`Google refused the download (${res.status}): its owner may have turned off downloading, or it isn't shared with the account signed in here`);
      }
      if (res.status < 200 || res.status >= 300) {
        why = `Google's export answered ${res.status}`;
        continue;
      }
      if (/text\/html/i.test(res.contentType)) {
        why = 'Google answered with a web page instead of the file (usually a sign-in or error page)';
        continue;
      }
      return { ok: true, label: target.label, text: new TextDecoder().decode(res.body), truncated: res.truncated };
    }
    return fail(why);
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** `ExportGet` over Electron's network stack, in `session` with its cookies. */
export function sessionGet(session: Session): ExportGet {
  return (url, { maxBytes, signal }) =>
    new Promise<ExportResponse>((resolve) => {
      const req = net.request({ url, session, credentials: 'include', redirect: 'manual' });
      let settled = false;
      const done = (r: ExportResponse) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => {
        done({ kind: 'error', message: 'aborted' });
        req.abort();
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('redirect', (_status, _method, to) => {
        if (exportRedirectAllowed(to)) return req.followRedirect();
        done({ kind: 'redirect', to });
        req.abort();
      });
      req.on('response', (res) => {
        const type = res.headers['content-type'];
        const contentType = Array.isArray(type) ? type.join(', ') : (type ?? '');
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size > maxBytes) {
            done({ kind: 'response', status: res.statusCode, contentType, body: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true });
            req.abort();
          }
        });
        res.on('end', () => done({ kind: 'response', status: res.statusCode, contentType, body: Buffer.concat(chunks), truncated: false }));
        res.on('error', (e: Error) => done({ kind: 'error', message: e.message }));
      });
      req.on('error', (e) => done({ kind: 'error', message: e.message }));
      req.end();
    });
}

/**
 * What `rig_browser_read` gets for a link: the export of the Google file the
 * agent's tab (`tab`, already loaded and past the sign-in check) shows, in
 * that tab's session. Null when the link isn't a Google editor link.
 */
export async function googleFullText(url: string, tab: { getURL(): string; session: Session }): Promise<GoogleExportResult | null> {
  const loaded = tab.getURL();
  const target = googleExportTarget(url, loaded);
  if (!target) return null;
  if (!sameGoogleFile(url, loaded)) return { ok: false, label: target.label, why: "the page didn't open on the file" };
  return readGoogleExport(target, sessionGet(tab.session));
}
