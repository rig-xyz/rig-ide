import { join, resolve } from 'node:path';
import { app } from 'electron';

/**
 * Resolves the real `userData/settings.json` path for the running app.
 * Imports Electron's `app` at module scope — like `db/path.ts` — so it must
 * only ever be reached from real boot code, never from tests (those
 * construct `RigSettingsStore` with an explicit path instead).
 */
export function resolveSettingsPath(): string {
  const explicit = process.env.RIG_SETTINGS_FILE?.trim();
  if (explicit) return resolve(explicit);
  return join(app.getPath('userData'), 'settings.json');
}
