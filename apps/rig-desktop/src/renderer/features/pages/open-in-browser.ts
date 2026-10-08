import { rpc } from '@renderer/lib/ipc';
import { isRigFileUrl } from '@shared/spaces/rig-file';

/**
 * The page panel's "Open in browser". A space's file opens as the real file
 * (a browser can't load `rig-file://`), resolved in main the way the panel
 * serves it; a web page opens as it is.
 */
export function openPageInBrowser(url: string): Promise<unknown> {
  return isRigFileUrl(url) ? rpc.rig.pages.openRigFileInBrowser({ url }) : rpc.app.openExternal(url);
}
