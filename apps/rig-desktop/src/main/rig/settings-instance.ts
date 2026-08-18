import { createRigSettingsController } from './settings-controller';
import { resolveSettingsPath } from './settings-path';
import { RigSettingsStore } from './settings';

/**
 * The one real settings store for the running app, pointed at the actual
 * `userData/settings.json`. Kept in its own module (rather than inline in
 * `rpc.ts` or `index.ts`) so both the RPC router and the boot sequence
 * (`initialize()`, `subscribe()` → renderer change event) can import the
 * same instance without a circular dependency between them.
 *
 * Deliberately separate from `settings.ts` (the store class) and
 * `settings-controller.ts` (the RPC shape) — those two stay Electron-import
 * free and are exercised directly in tests; this module is boot wiring only.
 */
export const rigSettingsStore = new RigSettingsStore(resolveSettingsPath());

export const rigSettingsController = createRigSettingsController(rigSettingsStore);
