import { join } from 'node:path';
import { app, dialog } from 'electron';
import { getMainWindow } from '@main/app/window';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { AttachmentInput } from '@shared/rig/attachments';
import { fetchWorkspaceBindings, isError, resolveContext } from '../account';
import { resolveLocalPathsImpl } from '../recent-rigs';
import { createAttachmentsService } from './service';
import type { ManifestSize } from './usage';

/**
 * Real wiring for the attachments service (Electron dialog, the local rigs
 * table, the relay). Tests use `createAttachmentsService` with fakes; nothing
 * under test imports this file.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const MANIFEST_PAGE = 5000;
const ROLE_TTL_MS = 60_000;

/** The space's current files on the relay (`GET /v1/me/bindings/:id/manifest`, member-readable), or null when unreachable. */
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
        if (typeof raw?.path !== 'string' || raw.deleted === true) continue;
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

const service = createAttachmentsService({
  resolveSpaceRoot: async (bindingId) => (await resolveLocalPathsImpl([bindingId]))[bindingId] ?? null,
  role: roleIn,
  fetchManifest,
  pasteDir: () => join(app.getPath('temp'), 'rig-pasted-attachments'),
});

export const rigAttachmentsController = createRPCController({
  /** The native picker: several files, no folders. Empty when cancelled. */
  pick: async (): Promise<string[]> => {
    const options: Electron.OpenDialogOptions = {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    };
    try {
      const win = getMainWindow();
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    } catch (error) {
      log.warn('Rig attachments: picker failed', { error: String(error) });
      throw error;
    }
  },
  /** What each chip should say, and whether the space can take them. Copies nothing. */
  prepare: ({ bindingId, files }: { bindingId: string; files: AttachmentInput[] }) => service.prepare(bindingId, files),
  /** At send: copy into `attachments/` (or link). All or nothing. */
  commit: ({ bindingId, files }: { bindingId: string; files: AttachmentInput[] }) => service.commit(bindingId, files),
  /** A pasted image's bytes → a temp file to attach. */
  savePastedImage: (args: { data: Uint8Array; mime: string; name?: string }) => service.savePastedImage(args),
});
