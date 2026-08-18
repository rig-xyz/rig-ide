import { shell, type BrowserWindow } from 'electron';
import { log } from '@main/lib/logger';

/**
 * Ensure any external HTTP(S) links open in the user's default browser
 * rather than inside the Electron window. Keeps app navigation scoped
 * to our renderer while preserving expected link behavior.
 *
 * Round (dead-channel fix): this used to hand off to the renderer via
 * `events.emit(externalLinkOpenRequestedChannel, …)` for it to act on — a
 * full-repo grep confirmed NOTHING ever subscribed to that channel, so a
 * real http(s) link clicked anywhere this file's handlers catch one (e.g. a
 * link chat-ui rendered inside a chat transcript message) silently did
 * nothing at all: `webContents.send` reached the renderer's IPC layer with
 * no listener registered for it, dropped without a trace — no browser
 * opened, no error, no toast, nothing the user could see. Fixed by opening
 * directly here in main, no renderer round-trip: the same http(s)-only
 * validation `appService.openExternal` (`main/core/app/service.ts`) applies
 * for every other external-link entry point (kept as an inline check here,
 * not an import of that class, to avoid a fresh circular import — `service.ts`
 * already depends on `main/app/window.ts`, which is what imports THIS file),
 * and the same no-confirm-dialog convention `confirmOpenExternalLink`
 * (renderer) already uses: this app opens externals directly, it never
 * prompts first.
 */
export function isHttpUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function requestExternalLinkOpen(url: string) {
  if (!isHttpUrl(url)) return;
  shell.openExternal(url).catch((error: unknown) => {
    log.warn('Failed to open external link', { url, error });
  });
}

export function registerExternalLinkHandlers(win: BrowserWindow, isDev: boolean) {
  const wc = win.webContents;

  const isInternalAppUrl = (url: string) => {
    if (isDev) return url.startsWith(process.env.ELECTRON_RENDERER_URL!);
    return url.startsWith('file://') || /^http:\/\/(127\.0\.0\.1|localhost):\d+(?:\/|$)/i.test(url);
  };

  // Handle window.open and target="_blank" — DENY unconditionally. A blank
  // BrowserWindow is never the right outcome for anything this app renders:
  // a genuine http(s) link routes through the existing external-link path
  // instead of a real window, and anything else (a relative href from
  // transcript prose that `classifyLink` didn't resolve to a workspace
  // file, e.g.) is a quiet no-op rather than an empty popup titled after
  // the app (the founder-dogfooding bug this round fixes).
  wc.setWindowOpenHandler(({ url }) => {
    if (!isInternalAppUrl(url) && /^https?:\/\//i.test(url)) {
      requestExternalLinkOpen(url);
    }
    return { action: 'deny' };
  });

  // Intercept navigations that would leave the app
  wc.on('will-navigate', (event, url) => {
    if (!isInternalAppUrl(url) && /^https?:\/\//i.test(url)) {
      event.preventDefault();
      requestExternalLinkOpen(url);
    }
  });
}
