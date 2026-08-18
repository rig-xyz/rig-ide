import { rpc } from '@renderer/lib/ipc';

/**
 * Opens a URL in the OS browser.
 *
 * Emdash's `confirmOpenExternalLink` shows a confirm dialog and offers to open
 * inside its own in-app browser pane — both drag in the task-view/modal system
 * this app doesn't have. The one caller here (`useRigSignIn`) only ever opens a
 * URL this app itself minted (`rig login`'s own sign-in link), not one from
 * untrusted content, so going straight to the OS browser is the right amount
 * of ceremony.
 */
export function confirmOpenExternalLink(url: string): void {
  void rpc.app.openExternal(url);
}
