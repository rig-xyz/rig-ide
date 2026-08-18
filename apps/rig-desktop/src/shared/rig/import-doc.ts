/**
 * Google Docs / .docx import contract (the "wow demo" round), shared by the
 * main-process pipeline (`main/rig/import-doc.ts`) and the renderer's two
 * entry points (the create dialog's "Start from a Google Doc" section and
 * the open-rig Import action).
 *
 * FIDELITY HONESTY (carried into every piece of UI copy): the pipeline is
 * docx-export → markdown. Text, headings, lists, tables, links, bold/italic
 * and images survive; Google Docs comments and suggestions do NOT survive
 * ANY export format — the UI must never imply otherwise.
 */

import { defineEvent } from '../lib/ipc/events';

export type RigImportSource =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string };

export type RigImportRequest = {
  /** The bound rig's workspace root — the import writes into it. */
  root: string;
  source: RigImportSource;
};

export type RigImportResult = {
  /** Absolute path of the written markdown file. */
  mdPath: string;
  /** Workspace-relative path (forward slashes) — what the file tree shows. */
  relPath: string;
  /** The doc's title as best known (export filename / picked file's name). */
  title: string;
  imageCount: number;
};

export type RigImportError = {
  kind: 'invalidUrl' | 'restricted' | 'notFound' | 'network' | 'convertFailed' | 'writeFailed';
  message: string;
};

/**
 * The Add menu's "From file…" request for anything that ISN'T a .docx (that
 * still routes through `RigImportRequest`/`importDoc` above, same pipeline
 * as the Import dialog's docx tile). A plain byte-for-byte copy into the
 * rig root, collision-safe naming only — no conversion.
 */
export type RigCopyFileRequest = {
  /** The bound rig's workspace root — the copy writes into it. */
  root: string;
  /** Absolute path of the file the user picked. */
  path: string;
};

export type RigCopyFileResult = {
  /** Absolute path of the copy written into the rig root. */
  absPath: string;
  /** Workspace-relative path (forward slashes) — what the file tree shows. */
  relPath: string;
};

/**
 * Mid-flight progress for one `importDoc` run (loose-ends round). `title`
 * is null until it's genuinely known — the export response's
 * Content-Disposition on the URL path (so `converting` is the first phase
 * that can carry it), the file's own name from the start on the .docx
 * path. The renderer subscribes only while its import dialog is working;
 * one import runs at a time, so the payload carries no correlation id.
 */
export type RigImportPhase = 'fetching' | 'converting' | 'writing';

export type RigImportProgress = {
  phase: RigImportPhase;
  title: string | null;
};

export const rigImportProgressChannel = defineEvent<RigImportProgress>('rig:import-progress');

/**
 * The document id out of any docs.google.com/document URL form — the id
 * segment right after `/d/` (Google's ids are URL-safe base64ish:
 * `[A-Za-z0-9_-]`). Tolerates `/u/<n>/` account prefixes, every trailing
 * form (`/edit`, `/view`, `/preview`, bare), fragments (`#heading=…`) and
 * query params (`?usp=sharing`), and a missing scheme (a bare paste).
 * Null for anything that isn't a Google DOCS document link — including
 * Sheets/Slides, deliberately: exporting those as docx is not a thing.
 */
export function parseGoogleDocId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.hostname !== 'docs.google.com') return null;
  const match = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
  return match?.[1] ?? null;
}

/** The unauthenticated docx export endpoint — the ONLY way this app reads a Google Doc (never HTML scraping, never auth). */
export function googleDocExportUrl(docId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(docId)}/export?format=docx`;
}
