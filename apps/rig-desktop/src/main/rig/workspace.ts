import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import * as toml from 'smol-toml';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { deriveUnboundDetection, type RigWorkspaceDetection } from '@shared/rig/workspace';
import { findBindingConfig } from './binding';
import { recordRigOpened } from './recent-rigs';

// Set by the macOS `open-file` handler in `main/index.ts`, which fires as
// soon as the process launches — often before a window (and its renderer)
// exists to receive an event. `consumePendingOpenFile` below is a one-shot
// pull the renderer makes exactly once at boot, so this only ever needs to
// hold a single path: if `open-file` fires again while already running, the
// window's already-mounted event listener handles it directly.
let pendingOpenFilePath: string | null = null;

/** Called from `main/index.ts`'s `open-file` handler, before `app.whenReady()`. */
export function bufferOpenFilePath(path: string): void {
  pendingOpenFilePath = path;
}

function readRigName(workspaceRoot: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(workspaceRoot, 'rig.toml'), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = toml.parse(raw);
    const rigSection = parsed.rig;
    if (
      rigSection &&
      typeof rigSection === 'object' &&
      'name' in rigSection &&
      typeof rigSection.name === 'string'
    ) {
      return rigSection.name;
    }
    return null;
  } catch {
    return null;
  }
}

export const rigWorkspaceController = createRPCController({
  /**
   * Detects whether `folderPath` (or an ancestor) is a bound rig workspace.
   * This is also the one call site every "open a rig" path shares (the Open
   * Folder… dialog and, from `open-file`, the native Open Recent flow both
   * route through it) — so a successful bind is recorded here: `rig_rigs` is
   * upserted and the path is added to macOS's own Open Recent list. Both are
   * best-effort; a failure there must never block the detection result the
   * renderer is waiting on to render the workspace.
   */
  detect: async (folderPath: string): Promise<RigWorkspaceDetection> => {
    if (!folderPath || typeof folderPath !== 'string') return { bound: false, unsynced: null };
    const location = findBindingConfig(folderPath);
    if (!location) {
      return deriveUnboundDetection({
        pickedPath: folderPath,
        pickedHasRigToml: existsSync(join(folderPath, 'rig.toml')),
        pickedName: readRigName(folderPath),
      });
    }
    const name = readRigName(location.workspaceRoot);

    try {
      await recordRigOpened({
        path: location.workspaceRoot,
        bindingId: location.config.bindingId,
        name,
      });
    } catch (error) {
      log.warn('rig: failed to record recent rig', { error: String(error) });
    }
    try {
      app.addRecentDocument(location.workspaceRoot);
    } catch (error) {
      log.warn('rig: failed to add recent document', { error: String(error) });
    }

    return {
      bound: true,
      bindingId: location.config.bindingId,
      workspaceRoot: location.workspaceRoot,
      name,
    };
  },

  /** One-shot: returns (and clears) a path buffered by `open-file` before the window existed. */
  consumePendingOpenFile: (): string | null => {
    const path = pendingOpenFilePath;
    pendingOpenFilePath = null;
    return path;
  },
});
