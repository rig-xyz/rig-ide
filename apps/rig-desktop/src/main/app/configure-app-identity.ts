import { join } from 'node:path';
import { app } from 'electron';
import { PRODUCT_NAME, USER_DATA_DIR_NAME } from '@shared/app-identity';

app.setName(PRODUCT_NAME);

// Dev-only escape hatch for regression harnesses that need a fully isolated
// userData dir (settings.json, the app DB default location, Chromium's own
// localStorage/session partitions) without relying on Electron's
// --user-data-dir switch, which this unconditional app.setPath() call would
// otherwise clobber. Ignored in packaged builds even if the env var is set.
const devUserDataDir = import.meta.env.DEV ? process.env.RIG_DEV_USER_DATA_DIR?.trim() : undefined;
app.setPath('userData', devUserDataDir || join(app.getPath('appData'), USER_DATA_DIR_NAME));
