import { isAbsolute, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { app, dialog, nativeImage } from 'electron';
import { getMainWindow } from '@main/app/window';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  ATTACHMENT_IMAGE_CONTENT_MAX_BYTES,
  type AttachmentFileStatus,
  type AttachmentInput,
  type AttachmentStatusQuery,
} from '@shared/rig/attachments';
import { filterToContentOnly } from '@shared/rig/file-navigator-categories';
import type { RigFileNode } from '@shared/rig/files';
import type { TaggableFile } from '@shared/rig/file-tags';
import { fetchWorkspaceBindings, isError, resolveContext } from '../account';
import { listDir } from '../files';
import { resolveLocalPathsImpl } from '../recent-rigs';
import { createAttachmentsService } from './service';
import { attachmentStatus, resolveInSpace } from './status';
import type { ManifestSize } from './usage';

/**
 * Real wiring for the attachments service (Electron dialog, the local rigs
 * table, the relay). Tests use `createAttachmentsService` with fakes; nothing
 * under test imports this file.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const MANIFEST_PAGE = 5000;
const ROLE_TTL_MS = 60_000;

/** The space's files on the relay, deleted ones marked (`GET /v1/me/bindings/:id/manifest`, member-readable), or null when unreachable. */
async function fetchManifest(bindingId: string): Promise<ManifestSize[] | null> {
  const ctx = await resolveContext();
  if (isError(ctx)) return null;
  const base = ctx.url.replace(/\/+$/, '');
  const out: ManifestSize[] = [];
  let after: string | undefined;
  try {
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: String(MANIFEST_PAGE), ...(after ? { after } : {}) });
      const response = await fetch(`${base}/v1/me/bindings/${encodeURIComponent(bindingId)}/manifest?${query}`, {
        headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { entries?: unknown; nextCursor?: unknown };
      if (!Array.isArray(body.entries)) return null;
      for (const raw of body.entries as Array<Record<string, unknown>>) {
        if (typeof raw?.path !== 'string') continue;
        // Deleted entries are kept, marked: they tell "someone removed it"
        // apart from "it never reached the relay" on message cards.
        if (raw.deleted === true) {
          out.push({ path: raw.path, size: null, deleted: true });
          continue;
        }
        out.push({ path: raw.path, size: typeof raw.size === 'number' ? raw.size : Number(raw.size) || null });
      }
      if (typeof body.nextCursor !== 'string' || !body.nextCursor) return out;
      after = body.nextCursor;
    }
    return out;
  } catch (error) {
    log.warn('Rig attachments: could not read the space’s file list', { bindingId, error: String(error) });
    return null;
  }
}

let roles: { at: number; byBinding: Map<string, string> } | null = null;

async function roleIn(bindingId: string): Promise<string | null> {
  if (!roles || Date.now() - roles.at > ROLE_TTL_MS || !roles.byBinding.has(bindingId)) {
    const listed = await fetchWorkspaceBindings();
    if (!listed.success) return roles?.byBinding.get(bindingId) ?? null;
    roles = { at: Date.now(), byBinding: new Map(listed.data.map((b) => [b.id, b.role])) };
  }
  return roles.byBinding.get(bindingId) ?? null;
}

const resolveSpaceRoot = async (bindingId: string) => (await resolveLocalPathsImpl([bindingId]))[bindingId] ?? null;

// The cards poll while files travel; one file-list read per space every 15 s at most.
const MANIFEST_TTL_MS = 15_000;
const manifestCache = new Map<string, { at: number; value: Promise<ManifestSize[] | null> }>();
function cachedManifest(bindingId: string): Promise<ManifestSize[] | null> {
  const hit = manifestCache.get(bindingId);
  if (hit && Date.now() - hit.at < MANIFEST_TTL_MS) return hit.value;
  const value = fetchManifest(bindingId);
  manifestCache.set(bindingId, { at: Date.now(), value });
  return value;
}

const THUMB_PX = 480;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;

/** Formats Chromium decodes itself: scaled directly, so the preview keeps the image's own proportions. */
const DIRECT_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const PDF_EXT = /\.pdf$/i;
/** A PDF's first page is shown small, in its card's badge. */
const PDF_THUMB_PX = 160;

/**
 * A small preview of an image file, made on this computer. Common formats
 * are scaled from the image itself; Quick Look (asked for a square) pads a
 * wide or tall image into that square with transparent space, which read as
 * a letterboxed picture in the chat, so it's only used for the rest (HEIC,
 * TIFF) or when scaling fails.
 */
async function thumbnailOf(abs: string): Promise<string | null> {
  if (PDF_EXT.test(abs)) return pdfThumbnailOf(abs);
  if (!IMAGE_EXT.test(abs)) return null;
  const scaled = async (): Promise<string | null> => {
    try {
      if ((await stat(abs)).size > ATTACHMENT_IMAGE_CONTENT_MAX_BYTES * 4) return null;
      const image = nativeImage.createFromPath(abs);
      if (image.isEmpty()) return null;
      const { width, height } = image.getSize();
      const scale = Math.min(1, THUMB_PX / Math.max(width, height));
      return (scale < 1 ? image.resize({ width: Math.round(width * scale) }) : image).toDataURL();
    } catch {
      return null;
    }
  };
  if (DIRECT_EXT.test(abs)) {
    const direct = await scaled();
    if (direct) return direct;
  }
  try {
    const image = await nativeImage.createThumbnailFromPath(abs, { width: THUMB_PX, height: THUMB_PX });
    if (!image.isEmpty()) return image.toDataURL();
  } catch {
    // no Quick Look here (Linux) or it declined
  }
  return DIRECT_EXT.test(abs) ? null : scaled();
}

/** A PDF's first page, from Quick Look (macOS); null where there's none (Linux, Windows) or it declined. */
async function pdfThumbnailOf(abs: string): Promise<string | null> {
  try {
    const image = await nativeImage.createThumbnailFromPath(abs, { width: PDF_THUMB_PX, height: PDF_THUMB_PX });
    return image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}

/** An image or a PDF in the space (paths from messages stay inside it). */
async function thumbnail(bindingId: string, path: string): Promise<string | null> {
  const root = await resolveSpaceRoot(bindingId);
  const abs = root ? await resolveInSpace(root, path) : null;
  return abs ? thumbnailOf(abs) : null;
}

const TAGGABLE_MAX = 5000;

/** The space's files as the Files navigator shows them (content only: no dot-folders, `rig.toml` or skills), flattened. */
async function taggableFiles(bindingId: string): Promise<TaggableFile[]> {
  const root = await resolveSpaceRoot(bindingId);
  if (!root) return [];
  let nodes: RigFileNode[];
  try {
    nodes = filterToContentOnly(await listDir(root, root));
  } catch (error) {
    log.warn('Rig attachments: could not list the space for +file suggestions', { error: String(error) });
    return [];
  }
  const out: TaggableFile[] = [];
  const walk = (list: RigFileNode[]) => {
    for (const node of list) {
      if (out.length >= TAGGABLE_MAX) return;
      if (node.kind === 'dir') walk(node.children ?? []);
      else out.push({ relPath: node.relPath, name: node.name, ...(node.mtimeMs ? { mtimeMs: node.mtimeMs } : {}) });
    }
  };
  walk(nodes);
  return out;
}

const service = createAttachmentsService({
  resolveSpaceRoot,
  role: roleIn,
  fetchManifest,
  pasteDir: () => join(app.getPath('temp'), 'rig-pasted-attachments'),
});

export const rigAttachmentsController = createRPCController({
  /** The native picker: several files, no folders. Empty when cancelled. */
  pick: async (): Promise<Array<{ path: string; size: number | null }>> => {
    const options: Electron.OpenDialogOptions = {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    };
    try {
      const win = getMainWindow();
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      // Sizes too, so a chip shows name and size before its checks come back.
      return Promise.all(
        result.filePaths.map(async (path) => ({ path, size: await stat(path).then((s) => (s.isFile() ? s.size : null), () => null) }))
      );
    } catch (error) {
      log.warn('Rig attachments: picker failed', { error: String(error) });
      throw error;
    }
  },
  /** What each chip should say, and whether the space can take them. Copies nothing. */
  prepare: ({ bindingId, files }: { bindingId: string; files: AttachmentInput[] }) => service.prepare(bindingId, files),
  /** How full the space is, for the pre-send quota check; separate from `prepare` since it may wait on the relay. */
  usage: ({ bindingId }: { bindingId: string }) => service.usage(bindingId),
  /** At send: copy into `attachments/` (or link). All or nothing. */
  commit: ({ bindingId, files }: { bindingId: string; files: AttachmentInput[] }) => service.commit(bindingId, files),
  /** Where each attached file is (here, synced, held back, on the relay) for the message cards; null when the space isn't linked here. */
  status: ({
    bindingId,
    files,
    withRelay = false,
  }: {
    bindingId: string;
    files: AttachmentStatusQuery[];
    withRelay?: boolean;
  }): Promise<AttachmentFileStatus[] | null> =>
    attachmentStatus({ resolveSpaceRoot, fetchManifest: cachedManifest }, bindingId, files.slice(0, 200), { withRelay }),
  /** A data URL preview of an image in the space (a PDF's first page), or null. */
  thumbnail: ({ bindingId, path }: { bindingId: string; path: string }): Promise<string | null> => thumbnail(bindingId, path),
  /** A preview of a file the user just attached (the chip's thumbnail; the composer asks for images only). */
  previewSource: ({ source }: { source: string }): Promise<string | null> =>
    isAbsolute(source) ? thumbnailOf(source) : Promise.resolve(null),
  /** The space's files for the composer's `+` suggestions (what the Files navigator shows). */
  listFiles: ({ bindingId }: { bindingId: string }): Promise<TaggableFile[]> => taggableFiles(bindingId),
  /** A pasted image's bytes → a temp file to attach. */
  savePastedImage: (args: { data: Uint8Array; mime: string; name?: string }) => service.savePastedImage(args),
});
