import { app } from 'electron';
import { log } from '@main/lib/logger';
import { rigSettingsStore } from '../settings-instance';
import { pagesSession } from './agent-pages';
import { readKeychainPassword } from './chrome-sign-in';
import { createPageSignIns } from './page-sign-ins';
import { checkSignIn } from './sign-in-check';

/** The app's one sign-ins flow: the settings file, the pages profile, the real Keychain. */
export const pageSignIns = createPageSignIns({
  getState: () => rigSettingsStore.get().pageSignIns,
  setState: (pageSignIns) => void rigSettingsStore.set({ pageSignIns }),
  keychain: readKeychainPassword,
  check: checkSignIn,
  pages: {
    set: (cookie) => pagesSession().cookies.set(cookie),
    list: () => pagesSession().cookies.get({}),
    remove: (url, name) => pagesSession().cookies.remove(url, name),
  },
});

let started = false;

/** "Keep in step with Chrome": looked at when rig's window gets focus again. */
export function startPageSignInsKeepInStep(): void {
  if (started) return;
  started = true;
  app.on('browser-window-focus', () => {
    void pageSignIns.keepInStep().catch((error: unknown) => log.warn('Rig pages: keep in step failed', { error: String(error) }));
  });
}
