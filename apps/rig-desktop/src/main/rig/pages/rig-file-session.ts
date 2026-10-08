import type { Session } from 'electron';
import { RIG_FILE_SCHEME } from '@shared/spaces/rig-file';
import { findBindingConfig } from '../binding';
import { resolveLocalPathsImpl } from '../recent-rigs';
import { rigFileRequestAllowed, rigFileResponse, type RigFileDeps } from './rig-file-protocol';

const installed = new WeakSet<Session>();

/** Where a space's files are on this Mac: what the protocol serves from, and what "Open in browser" opens. */
export const rigFileDeps: RigFileDeps = {
  rootFor: async (bindingId) => (await resolveLocalPathsImpl([bindingId]))[bindingId] ?? null,
  bindingAt: (dir) => findBindingConfig(dir)?.config.bindingId ?? null,
};

/**
 * Serves `rig-file://` in a session: the space files' own profile
 * (`rigFilesSession`), which the page panel and agents' hidden tabs share
 * for these links. A protocol handler belongs to one session, so nothing
 * else (the app's own window, the pages browser with the person's web
 * sign-ins, the general in-app browser) can load these links.
 */
export function installRigFileProtocol(ses: Session): void {
  if (installed.has(ses)) return;
  installed.add(ses);
  // The handler never learns who asked, so this hook decides: only a space's own pages pull in its files.
  ses.webRequest.onBeforeRequest({ urls: [`${RIG_FILE_SCHEME}://*/*`] }, (details, callback) => {
    const asking = details.resourceType === 'subFrame' ? (details.frame?.parent?.url ?? null) : (details.frame?.url ?? null);
    callback({ cancel: !rigFileRequestAllowed(details.url, details.resourceType, asking) });
  });
  ses.protocol.handle(RIG_FILE_SCHEME, (request) => rigFileResponse(request, rigFileDeps));
}
