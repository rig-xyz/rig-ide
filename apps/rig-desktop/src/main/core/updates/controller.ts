import { app, shell } from 'electron';
import { updateService } from '@main/core/updates/update-service';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { RIG_RELEASES_URL } from '@shared/urls';
import { formatUpdaterError } from './utils';

export const updateController = createRPCController({
  /**
   * Whether the updater can do anything at all. electron-updater refuses to
   * run unpacked, so in development `initialize()` throws and the service
   * never activates — a "Check for updates" click then resolves to null
   * with no event emitted, which reads to the user as a dead button. The
   * UI asks this first and says so plainly instead.
   */
  isSupported: async () => app.isPackaged,

  check: async () => {
    try {
      const result = await updateService.checkForUpdates();
      return { success: true, result: result ?? null };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },

  download: async () => {
    try {
      await updateService.downloadUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },

  quitAndInstall: async () => {
    try {
      updateService.quitAndInstall();
      return { success: true };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },

  openLatest: async () => {
    try {
      await shell.openExternal(RIG_RELEASES_URL);
      setTimeout(() => {
        try {
          app.quit();
        } catch {}
      }, 500);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  getState: async () => {
    try {
      const state = updateService.getState();
      return { success: true, data: state };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },

  getReleaseNotes: async () => {
    try {
      const notes = await updateService.fetchReleaseNotes();
      return { success: true, data: notes };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },
});
