type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';

// Bundle identifier — ours, not upstream's: it is the identity macOS signing
// and notarization key off, and it must never collide with com.emdash.* or
// xyz.userig.rig (the emdash-desktop app this one was forked from).
// Changing it does not move user data (USER_DATA_DIR_NAME below is explicit).
export const APP_ID = isCanary ? 'xyz.userig.rig-desktop.canary' : 'xyz.userig.rig-desktop';
// Display name only — it drives app.setName, the window title and UI copy.
// Deliberately NOT wired to USER_DATA_DIR_NAME (below), APP_NAME_LOWER (the
// app:// protocol scheme) or the release identifiers, so renaming the product
// cannot move anyone's data, change the renderer origin, or point updates at a
// channel that doesn't exist.
export const PRODUCT_NAME = isCanary ? 'Rig Canary' : 'Rig';
// Distinct from emdash-desktop's 'emdash'/'emdash-canary' so both apps' dev
// userData dirs and app:// origins never collide on the same machine.
export const APP_NAME_LOWER = isCanary ? 'rig-desktop-canary' : 'rig-desktop';
export const USER_DATA_DIR_NAME = isDev
  ? 'rig-desktop-dev'
  : isCanary
    ? 'rig-desktop-canary'
    : 'rig-desktop';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isCanary ? 'rig-canary' : 'rig';
// Our release bucket (Cloudflare R2 behind the userig.xyz zone). The updater
// polls `${R2_BASE_URL}/${UPDATE_CHANNEL}` for latest-mac.yml; artifacts are
// uploaded there by the release step. Upstream's was releases.emdash.sh.
export const R2_BASE_URL = 'https://dl.userig.xyz';
export const IS_CANARY = isCanary;
