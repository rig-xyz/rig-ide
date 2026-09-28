import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPanelPage, type ContentsLike } from './panel-page';

// Automatic sign-in (a copy of a Chrome sign-in, maybe a Keychain prompt)
// must only ever start from a page the person opened in the panel, never
// from an agent reading a page.

const pages = { name: 'pages session' };
const other = { name: 'another session' };
const contents = (over: Partial<ContentsLike> & { destroyed?: boolean } = {}): ContentsLike => ({
  getType: () => 'webview',
  isDestroyed: () => over.destroyed === true,
  session: pages,
  hostWebContents: { id: 1 },
  ...over,
});

describe('isPanelPage', () => {
  it('accepts a panel page: a webview in the pages profile, hosted by the app window', () => {
    expect(isPanelPage(contents(), pages)).toBe(true);
  });

  it("refuses an agent's hidden tab (a BrowserWindow in the same profile)", () => {
    expect(isPanelPage(contents({ getType: () => 'window', hostWebContents: undefined }), pages)).toBe(false);
    expect(isPanelPage(contents({ getType: () => 'window' }), pages)).toBe(false);
  });

  it('refuses anything else: another profile, no host, gone, unknown id', () => {
    expect(isPanelPage(contents({ session: other }), pages)).toBe(false);
    expect(isPanelPage(contents({ hostWebContents: null }), pages)).toBe(false);
    expect(isPanelPage(contents({ destroyed: true }), pages)).toBe(false);
    expect(isPanelPage(null, pages)).toBe(false);
  });
});

describe('the agent path', () => {
  const AGENT_FILES = ['browser-tools.ts', 'browser-rig-tools.ts', 'agent-pages.ts', 'link-titles.ts'];
  // Reading a record or marking one expired is fine; copying or asking the Keychain is not.
  const SIGN_IN_CALLS = /autoSignIn|readKeychainPassword|readSiteCookies|pageSignIns\.(signIn|refresh|connect|keepInStep)\b/;

  it.each(AGENT_FILES)('%s never reaches an import or the Keychain', (file) => {
    const source = readFileSync(path.join(__dirname, file), 'utf8');
    expect(source).not.toMatch(SIGN_IN_CALLS);
  });
});
