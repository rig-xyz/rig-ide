import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join as joinPath } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigSlug } from '@shared/rig/create';
import {
  googleDocExportUrl,
  parseGoogleDocId,
  rigImportProgressChannel,
  type RigCopyFileRequest,
  type RigCopyFileResult,
  type RigImportError,
  type RigImportProgress,
  type RigImportRequest,
  type RigImportResult,
} from '@shared/rig/import-doc';

/**
 * Google Docs / .docx → markdown import pipeline (main process).
 *
 * URL path: the doc id is parsed from the pasted link (`parseGoogleDocId`,
 * shared) and ONLY the unauthenticated docx export endpoint is fetched —
 * never the HTML page, never any auth flow. A restricted doc answers that
 * export with a redirect to accounts.google.com (or 401/403, or an HTML
 * login page) — mapped to one honest message telling the user to make it
 * link-viewable or drop the .docx instead.
 *
 * Conversion: mammoth (docx → HTML; BSD-2-Clause) then turndown + the gfm
 * plugin (HTML → markdown with tables; both MIT). Images come out of
 * mammoth as buffers and are written to `assets/<doc-slug>/img-N.<ext>`,
 * referenced relatively from the markdown. Comments/suggestions do NOT
 * survive any docx export — nothing here pretends otherwise.
 */

const FETCH_TIMEOUT_MS = 30_000;
/** Names that would collide get `-2`, `-3`, … — never overwritten. */
const MAX_NAME_ATTEMPTS = 100;

// ── pure pieces (exported for direct unit testing) ───────────────────────────

export type ExportResponseFacts = {
  status: number;
  /** `response.url` after redirects. */
  finalUrl: string;
  contentType: string | null;
};

/**
 * The CRITICAL error taxonomy for the export fetch. Restriction shows up
 * three ways depending on Google's mood — a redirect into
 * accounts.google.com, a plain 401/403, or a 200 HTML login/interstitial
 * page — all of them mean the same thing to the user.
 */
export function classifyExportResponse(facts: ExportResponseFacts): RigImportError | null {
  const restricted: RigImportError = {
    kind: 'restricted',
    message:
      'This doc is restricted. Make it viewable via link (Share → Anyone with the link), or download it as .docx and drop it here.',
  };
  if (facts.finalUrl.includes('accounts.google.com')) return restricted;
  if (facts.status === 401 || facts.status === 403) return restricted;
  if (facts.status === 404) {
    return { kind: 'notFound', message: "Couldn't find that doc — check the link." };
  }
  if (facts.status >= 200 && facts.status < 300) {
    if (facts.contentType?.includes('text/html')) return restricted;
    return null;
  }
  return {
    kind: 'network',
    message: `Google Docs answered unexpectedly (${facts.status}) — try again, or download the doc as .docx.`,
  };
}

/** `filename="My Doc.docx"` / RFC 5987 `filename*=UTF-8''My%20Doc.docx` out of Content-Disposition. */
export function titleFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const starMatch = /filename\*=(?:UTF-8''|utf-8'')([^;]+)/.exec(header);
  if (starMatch?.[1]) {
    try {
      return stripDocxExt(decodeURIComponent(starMatch[1].trim()));
    } catch {
      // fall through to the plain form
    }
  }
  const plainMatch = /filename="([^"]+)"/.exec(header);
  if (plainMatch?.[1]) return stripDocxExt(plainMatch[1]);
  return null;
}

function stripDocxExt(name: string): string {
  return name.replace(/\.docx$/i, '').trim();
}

/**
 * First name in `base`, `base-2`, `base-3`, … that `exists` rejects — the
 * never-overwrite rule for both the .md file and its assets folder (one
 * shared suffix, so `doc-2.md` always pairs with `assets/doc-2/`).
 */
export function uniqueSlug(base: string, exists: (candidate: string) => boolean): string {
  if (!exists(base)) return base;
  for (let n = 2; n < MAX_NAME_ATTEMPTS; n++) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  // Pathological (100 imports of the same doc) — timestamp is still unique.
  return `${base}-${Date.now()}`;
}

/**
 * The Add menu's "From file…" collision-safe name for a plain copy — same
 * `base`, `base-2`, `base-3`, … numbering as `uniqueSlug`, applied to the
 * name minus its extension so the extension survives untouched (`doc.txt`,
 * `doc-2.txt`, …). `exists` is asked about the FULL candidate filename
 * (extension included), unlike `uniqueSlug`'s own `base`-only candidates.
 */
export function uniqueFileName(original: string, exists: (candidateFileName: string) => boolean): string {
  const ext = extname(original);
  const base = ext ? original.slice(0, -ext.length) : original;
  const uniqueBase = uniqueSlug(base || 'file', (candidateBase) => exists(`${candidateBase}${ext}`));
  return `${uniqueBase}${ext}`;
}

/**
 * A5 fix — atomically CLAIMS a slug + its `assets/<slug>` directory,
 * rather than `uniqueSlug`'s plain `existsSync` probe (still used for the
 * `.md` half of the check below): two concurrent imports of the same
 * title used to both pass the identical "is this slug free" check before
 * either had written anything, then race writing into the SAME
 * `assets/<slug>/` folder — cross-corrupting each other's images.
 * `mkdirSync` without `recursive` is exclusive at the OS level (EEXIST on
 * a genuine collision, whether from a real prior import or a concurrent
 * one that claimed it a moment earlier), so the candidate this returns is
 * guaranteed to have been THIS call's own, empty, newly-created directory —
 * never a shared one. Candidate numbering mirrors `uniqueSlug` exactly.
 */
export function claimImportSlug(root: string, base: string): { slug: string; assetsDir: string } {
  const assetsRoot = joinPath(root, 'assets');
  mkdirSync(assetsRoot, { recursive: true });
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    if (existsSync(joinPath(root, `${candidate}.md`))) continue;
    const assetsDir = joinPath(assetsRoot, candidate);
    try {
      mkdirSync(assetsDir);
      return { slug: candidate, assetsDir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  // Pathological (100 imports of the same doc) — timestamp is still
  // unique, mirroring `uniqueSlug`'s own fallback.
  const candidate = `${base}-${Date.now()}`;
  const assetsDir = joinPath(assetsRoot, candidate);
  mkdirSync(assetsDir, { recursive: true });
  return { slug: candidate, assetsDir };
}

/**
 * Best-effort cleanup for a failed import — mirrors `create.ts`'s own
 * "never leave an empty husk behind" convention, extended to the assets
 * dir (which, unlike `create.ts`'s guaranteed-empty target folder, may
 * genuinely hold partial images by the time conversion or the final `.md`
 * write fails). Never throws — a cleanup failure must never mask or
 * replace the real error already being returned to the caller.
 */
function cleanupFailedImport(assetsDir: string, mdPath: string): void {
  try {
    rmSync(assetsDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  try {
    rmSync(mdPath, { force: true });
  } catch {
    // best-effort
  }
}

/** `image/png` → `png`, `image/jpeg` → `jpg`, `image/svg+xml` → `svg`; anything unknown falls back to `png`. */
export function imageExtension(contentType: string | null | undefined): string {
  const subtype = contentType?.split('/')[1]?.split('+')[0]?.trim().toLowerCase();
  if (!subtype) return 'png';
  if (subtype === 'jpeg') return 'jpg';
  return /^[a-z0-9]+$/.test(subtype) ? subtype : 'png';
}

/**
 * Mammoth's tables are `td`-only (docx — and therefore every Google Docs
 * export — has no semantic header row), and turndown-plugin-gfm only
 * converts tables that START with a heading row; every cell also arrives
 * wrapped in `<p>`, whose newlines would break pipe rows. Best-faith,
 * verified-on-fixture preparation: unwrap cell paragraphs (multi-paragraph
 * cells join with `<br />`) and promote the first row to `th` when no `th`
 * exists. Regex is safe here — this only ever runs on mammoth's own
 * machine-regular output, never arbitrary HTML.
 */
export function prepareDocxHtmlForMarkdown(html: string): string {
  return html.replace(/<table>(.*?)<\/table>/gs, (table, inner: string) => {
    let out = inner
      .replace(/<(td|th)([^>]*)>\s*<p>/g, '<$1$2>')
      .replace(/<\/p>\s*<\/(td|th)>/g, '</$1>')
      .replace(/<\/p>\s*<p>/g, '<br />');
    if (!out.includes('<th')) {
      out = out.replace(/<tr>(.*?)<\/tr>/s, (row, cells: string) =>
        `<tr>${cells.replaceAll('<td', '<th').replaceAll('</td>', '</th>')}</tr>`
      );
    }
    return `<table>${out}</table>`;
  });
}

// ── conversion boundary (exported so the fixture test runs the REAL path) ────

export type ConvertedDoc = { markdown: string; imageCount: number };

/**
 * The whole docx → markdown conversion, images delegated to `writeImage`
 * (index and extension in, markdown-relative src out) so tests can count
 * them without touching a filesystem.
 */
export async function convertDocxToMarkdown(
  buffer: Buffer,
  writeImage: (index: number, extension: string, bytes: Buffer) => string
): Promise<ConvertedDoc> {
  let imageCount = 0;
  const html = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const bytes = await image.read();
        const index = ++imageCount;
        const src = writeImage(index, imageExtension(image.contentType), Buffer.from(bytes));
        return { src };
      }),
    }
  );

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  turndown.use(gfm);
  // Keep image nodes intact (turndown handles <img> natively via its own
  // rule); tables need the preparation above, nothing else needs custom
  // rules for the fidelity we claim.
  const markdown = turndown.turndown(prepareDocxHtmlForMarkdown(html.value));
  return { markdown: `${markdown.trim()}\n`, imageCount };
}

// ── fetch + controller ───────────────────────────────────────────────────────

type FetchedDoc = { buffer: Buffer; title: string | null };

async function fetchGoogleDocAsDocx(url: string): Promise<Result<FetchedDoc, RigImportError>> {
  const docId = parseGoogleDocId(url);
  if (!docId) {
    return err<RigImportError>({
      kind: 'invalidUrl',
      message: "That doesn't look like a Google Docs link.",
    });
  }

  let response: Response;
  try {
    response = await fetch(googleDocExportUrl(docId), {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn('Rig import: Google Docs export fetch failed', { error: String(error) });
    return err<RigImportError>({
      kind: 'network',
      message: "Couldn't reach Google Docs — check your connection and try again.",
    });
  }

  const verdict = classifyExportResponse({
    status: response.status,
    finalUrl: response.url,
    contentType: response.headers.get('content-type'),
  });
  if (verdict) return err(verdict);

  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    return ok({
      buffer,
      title: titleFromContentDisposition(response.headers.get('content-disposition')),
    });
  } catch (error) {
    log.warn('Rig import: could not read the export body', { error: String(error) });
    return err<RigImportError>({
      kind: 'network',
      message: 'The download broke off — try again.',
    });
  }
}

export const rigImportController = createRPCController({
  importDoc: async ({
    root,
    source,
  }: RigImportRequest): Promise<Result<RigImportResult, RigImportError>> => {
    const progress = (phase: RigImportProgress['phase'], title: string | null) =>
      events.emit(rigImportProgressChannel, { phase, title });

    // 1. Get the docx bytes + best-known title. The URL path can only name
    // the doc once the export response's Content-Disposition arrives — so
    // `fetching` goes out title-less and `converting` is the first phase
    // that carries the real title; a picked file is named from the start.
    let buffer: Buffer;
    let title: string;
    if (source.kind === 'url') {
      progress('fetching', null);
      const fetched = await fetchGoogleDocAsDocx(source.url);
      if (!fetched.success) return fetched;
      buffer = fetched.data.buffer;
      title = fetched.data.title ?? 'Imported doc';
    } else {
      try {
        buffer = await readFile(source.path);
      } catch (error) {
        return err<RigImportError>({
          kind: 'writeFailed',
          message: `Couldn't read that file: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      title = basename(source.path).replace(/\.docx$/i, '') || 'Imported doc';
    }
    progress('converting', title);

    // 2. One collision-free slug, its assets folder ATOMICALLY claimed
    // (A5 fix — see `claimImportSlug`'s own doc comment for why a plain
    // existence check alone isn't enough for two concurrent imports).
    const baseSlug = rigSlug(title) || 'imported-doc';
    const { slug, assetsDir } = claimImportSlug(root, baseSlug);
    const assetsRel = `assets/${slug}`;
    const relPath = `${slug}.md`;
    const mdPath = joinPath(root, relPath);

    // 3. Convert, writing images as they stream out of mammoth. `wx`
    // (A5 fix) — exclusive, matching the `.md` write below — the assets
    // dir is this call's own freshly-claimed one, so a collision here
    // would mean a genuine bug, not something to silently paper over by
    // overwriting.
    let converted: ConvertedDoc;
    try {
      converted = await convertDocxToMarkdown(buffer, (index, extension, bytes) => {
        const fileName = `img-${index}.${extension}`;
        writeFileSync(joinPath(assetsDir, fileName), bytes, { flag: 'wx' });
        return `${assetsRel}/${fileName}`;
      });
    } catch (error) {
      log.warn('Rig import: docx conversion failed', { error: String(error) });
      cleanupFailedImport(assetsDir, mdPath);
      return err<RigImportError>({
        kind: 'convertFailed',
        message: "Couldn't convert that document — is it a real .docx?",
      });
    }

    // 4. Write the markdown, never over anything (slug is already unique).
    progress('writing', title);
    try {
      writeFileSync(mdPath, converted.markdown, { flag: 'wx' });
    } catch (error) {
      cleanupFailedImport(assetsDir, mdPath);
      return err<RigImportError>({
        kind: 'writeFailed',
        message: `Couldn't write ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return ok({ mdPath, relPath, title, imageCount: converted.imageCount });
  },

  /**
   * The Add menu's "From file…" fallback for anything that isn't a .docx
   * (the caller routes .docx through `importDoc` above instead — same
   * pipeline the Import dialog's docx tile uses). A plain copy, never
   * overwriting (`wx`, `uniqueFileName` — same never-overwrite convention
   * as the docx path's `.md`/image writes above).
   */
  copyFile: async ({ root, path }: RigCopyFileRequest): Promise<Result<RigCopyFileResult, RigImportError>> => {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      return err<RigImportError>({
        kind: 'writeFailed',
        message: `Couldn't read that file: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const relPath = uniqueFileName(basename(path), (candidate) => existsSync(joinPath(root, candidate)));
    const absPath = joinPath(root, relPath);
    try {
      writeFileSync(absPath, bytes, { flag: 'wx' });
    } catch (error) {
      return err<RigImportError>({
        kind: 'writeFailed',
        message: `Couldn't write ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return ok({ absPath, relPath });
  },
});
