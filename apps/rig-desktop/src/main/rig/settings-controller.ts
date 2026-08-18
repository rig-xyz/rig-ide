import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigSettings, RigSettingsLegacyImport, RigSettingsPatch } from '@shared/rig/settings';
import type { RigSettingsStore } from './settings';

/**
 * Thin RPC wrapper around a `RigSettingsStore` instance — kept as a factory
 * (rather than importing a module-level singleton store directly) so the
 * real store built from `resolveSettingsPath()` in `main/index.ts` is the
 * only one that ever gets wired to IPC, while this controller's shape stays
 * unit-testable against a store pointed at a temp file.
 */
export function createRigSettingsController(store: RigSettingsStore) {
  return createRPCController({
    get: (): RigSettings => store.get(),
    set: (patch: RigSettingsPatch): RigSettings => store.set(patch),
    importLegacy: (legacy: RigSettingsLegacyImport): RigSettings => store.importLegacy(legacy),
  });
}
