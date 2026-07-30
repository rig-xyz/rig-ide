type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';

export const APP_ID = isCanary ? 'com.emdash.canary' : 'com.emdash.stable';
// Display name only — it drives app.setName, the window title and UI copy.
// Deliberately NOT wired to USER_DATA_DIR_NAME (below), APP_NAME_LOWER (the
// app:// protocol scheme) or the release identifiers, so renaming the product
// cannot move anyone's data, change the renderer origin, or point updates at a
// channel that doesn't exist.
export const PRODUCT_NAME = isCanary ? 'Rig Canary' : 'Rig';
export const APP_NAME_LOWER = isCanary ? 'emdash-canary' : 'emdash';
export const USER_DATA_DIR_NAME = isDev ? 'emdash-dev' : isCanary ? 'emdash-canary' : 'emdash';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isCanary ? 'emdash-canary' : 'emdash';
export const R2_BASE_URL = 'https://releases.emdash.sh';
export const IS_CANARY = isCanary;
