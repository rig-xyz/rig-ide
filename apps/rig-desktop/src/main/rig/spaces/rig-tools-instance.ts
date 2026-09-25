import { readFile, stat } from 'node:fs/promises';
import { err, ok, type Result } from '@emdash/shared';
import type { RigFileNode } from '@shared/rig/files';
import { findBindingConfig } from '../binding';
import { rigCommentsController } from '../comments';
import { rigFileRootRegistry } from '../file-root-registry';
import { rigFilesController } from '../files';
import { rigPulseController } from '../pulse';
import { rigShareController } from '../rig-share';
import { createHttpSpacesRelayApi } from './relay-api';
import type { RigToolsBackend } from './rig-tools';
import { createRigToolsServer } from './rig-tools-server';

/**
 * Boot-only wiring for the rig tools server: the real backends, each the one
 * the desktop already uses for the same thing (the Share popover's invite,
 * the Room's member and invite lists, Details → Changes' file listing and
 * Pulse line, the doc margin's comments). Kept out of `rig-tools.ts` and
 * `rig-tools-server.ts` for the same reason as `dispatch-controller-instance.ts`:
 * these modules touch Electron at load time, so nothing under test may import
 * this file.
 */

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

const api = createHttpSpacesRelayApi();

/** Runs `fn` with `root` registered as a file root, and always lets it go again. */
async function withRoot<T>(root: string, fn: (rootId: string) => Promise<T>, fallback: T): Promise<T> {
  const registered = await rigFileRootRegistry.register(root);
  if (!registered.success) return fallback;
  try {
    return await fn(registered.data.rootId);
  } finally {
    rigFileRootRegistry.release(registered.data.rootId);
  }
}

const backend: RigToolsBackend = {
  whoami: () => api.whoami(),
  bindingAt: (dir) => findBindingConfig(dir)?.config.bindingId ?? null,
  createInvite: (root, email, role) => rigShareController.createInvite({ root, email, role }),
  listMembers: (bindingId) => api.listMembers(bindingId),
  listInvites: async (bindingId) => (api.listInvites ? api.listInvites(bindingId) : ok([])),
  listFiles: (root) =>
    withRoot<Result<RigFileNode[], { message: string }>>(
      root,
      (rootId) => rigFilesController.list({ rootId }),
      err({ message: "the space's folder isn't available" })
    ),
  spaceStory: async (bindingId) => {
    // Account-wide briefing: only this space's own line is ever used, never other rigs' or people's lines.
    const pulse = await rigPulseController.get({});
    if (!pulse.success) return null;
    return pulse.data.briefing.perRig.find((item) => item.bindingId === bindingId)?.line || null;
  },
  listComments: async (absPath) => {
    const listed = await rigCommentsController.list({ absPath });
    return listed.success ? ok(listed.data.messages) : err(listed.error);
  },
  readText: (root, relPath) =>
    withRoot(
      root,
      async (rootId) => {
        const resolved = await rigFileRootRegistry.resolveExisting(rootId, relPath);
        if (!resolved.success) return null;
        try {
          if ((await stat(resolved.data)).size > MAX_TEXT_BYTES) return null;
          return await readFile(resolved.data, 'utf8');
        } catch {
          return null;
        }
      },
      null
    ),
  createComment: ({ absPath, body, anchor, meta }) =>
    rigCommentsController.create({ absPath, body, anchor, authorKind: 'agent', meta }),
  replyComment: ({ absPath, parentId, body, meta }) =>
    rigCommentsController.reply({ absPath, parentId, body, authorKind: 'agent', meta }),
};

export const rigToolsServer = createRigToolsServer({ backend });
