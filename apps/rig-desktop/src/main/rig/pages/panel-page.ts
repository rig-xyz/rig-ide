/**
 * Who may sign a page in automatically (board 18, revised): only a page the
 * person opened in the panel. That page is a `<webview>` guest, hosted by
 * the app's window, in the pages browser profile. Agents read pages in
 * hidden `BrowserWindow`s of their own (`agent-pages.ts`), which are
 * 'window' contents with no host: they can never pass this, so an agent can
 * never make rig copy a sign-in or make macOS ask for the Keychain.
 */

/** The parts of an Electron `WebContents` the gate looks at. */
export interface ContentsLike {
  getType(): string;
  isDestroyed(): boolean;
  session: unknown;
  hostWebContents?: unknown;
}

export function isPanelPage(wc: ContentsLike | null | undefined, pagesSession: unknown): boolean {
  return !!wc && !wc.isDestroyed() && wc.getType() === 'webview' && !!wc.hostWebContents && wc.session === pagesSession;
}
