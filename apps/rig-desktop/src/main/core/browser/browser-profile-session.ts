import { app, session, type Session } from 'electron';
import { log } from '@main/lib/logger';
import type { AppSettings } from '@shared/core/app-settings';
import {
  applyLocalDevelopmentCorsRelaxation,
  localDevelopmentCorsRelaxationRequest,
  type BrowserCorsRelaxationRequest,
} from './browser-cors-relaxation';
import {
  firefoxUserAgent,
  isGoogleAuthUrl,
  stripEmbeddedBrowserTokens,
} from './browser-user-agent';

// Web permissions the embedded browser may use without asking. Everything else
// (camera, microphone, geolocation, notifications, USB/HID/serial, …) is denied:
// the in-app browser holds logged-in sessions and must not become a side channel
// into device capabilities (Electron security checklist #5).
const ALLOWED_BROWSER_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
]);

const configuredPartitions = new Set<string>();
/**
 * A partition's own changes to outgoing request headers, run inside the one
 * `onBeforeSendHeaders` listener a session can have (a second listener would
 * replace the first). Looked up per request, so it applies whichever caller
 * configured the partition first.
 */
type RequestHeadersHook = (url: string, headers: Record<string, string>) => void;
const requestHeadersHooks = new Map<string, RequestHeadersHook>();

export function setRequestHeadersHook(partition: string, hook: RequestHeadersHook): void {
  requestHeadersHooks.set(partition, hook);
}
let relaxCorsForLocalDevelopment = false;

export function setBrowserCorsRelaxationSettings(browser: AppSettings['browser']): void {
  relaxCorsForLocalDevelopment = browser.relaxCorsForLocalhost;
}

/**
 * Returns the session for a browser partition, applying profile-wide hardening
 * exactly once per partition: deny-by-default permissions, an embedded-browser
 * user agent without Electron tokens, and a Firefox user agent on Google auth
 * hosts so third-party "Sign in with Google" flows are not rejected.
 */
export function configureBrowserProfileSession(partition: string): Session {
  const ses = session.fromPartition(partition);
  if (configuredPartitions.has(partition)) return ses;
  configuredPartitions.add(partition);

  ses.setUserAgent(stripEmbeddedBrowserTokens(ses.getUserAgent(), app.getName()));

  const corsRequests = new Map<number, BrowserCorsRelaxationRequest>();

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (isGoogleAuthUrl(details.url)) {
      details.requestHeaders['User-Agent'] = firefoxUserAgent();
    }
    requestHeadersHooks.get(partition)?.(details.url, details.requestHeaders);

    const corsRequest = relaxCorsForLocalDevelopment
      ? localDevelopmentCorsRelaxationRequest(details.requestHeaders)
      : null;
    if (corsRequest) corsRequests.set(details.id, corsRequest);
    else corsRequests.delete(details.id);

    callback({ requestHeaders: details.requestHeaders });
  });

  ses.webRequest.onHeadersReceived((details, callback) => {
    const corsRequest = corsRequests.get(details.id);
    corsRequests.delete(details.id);
    if (!relaxCorsForLocalDevelopment || !corsRequest || !details.responseHeaders) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    callback({
      responseHeaders: applyLocalDevelopmentCorsRelaxation(details.responseHeaders, corsRequest),
    });
  });

  ses.webRequest.onCompleted((details) => {
    corsRequests.delete(details.id);
  });
  ses.webRequest.onErrorOccurred((details) => {
    corsRequests.delete(details.id);
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const granted = ALLOWED_BROWSER_PERMISSIONS.has(permission);
    if (!granted) {
      log.debug('Denied browser permission request', { permission });
    }
    callback(granted);
  });
  ses.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_BROWSER_PERMISSIONS.has(permission)
  );

  return ses;
}
