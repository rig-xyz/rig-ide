import { beforeEach, describe, expect, it, vi } from 'vitest';

// Space files (`rig-file://`) open in a profile of their own, never in the
// pages browser that holds the person's web sign-ins, for agents' tabs as
// for the panel. Only that profile serves the files.

const sessions = new Map<string, { partition: string }>();
const installed: string[] = [];
const headerHooks = new Map<string, (url: string, headers: Record<string, string>) => void>();
const windows: { session: unknown; url?: string }[] = [];

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { id: 1 };
    constructor(opts: { webPreferences: { session: unknown } }) {
      windows.push({ session: opts.webPreferences.session });
    }
    loadURL(url: string) {
      windows.at(-1)!.url = url;
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    destroy() {}
  },
}));
vi.mock('@main/core/browser/browser-profile-session', () => ({
  configureBrowserProfileSession: (partition: string) => {
    if (!sessions.has(partition)) sessions.set(partition, { partition });
    return sessions.get(partition);
  },
  setRequestHeadersHook: (partition: string, hook: (url: string, headers: Record<string, string>) => void) => headerHooks.set(partition, hook),
}));
vi.mock('./rig-file-session', () => ({
  installRigFileProtocol: (ses: { partition: string }) => installed.push(ses.partition),
}));

const { agentPage, closeAgentPages, isPagesBrowserSession, pagesSession, rigFilesSession, sessionForPage } = await import('./agent-pages');
const { RIG_PAGES_PARTITION } = await import('@shared/spaces/links');
const { RIG_FILES_PARTITION } = await import('@shared/spaces/rig-file');

beforeEach(() => {
  installed.length = 0;
  windows.length = 0;
  closeAgentPages();
});

describe('the space files profile', () => {
  it('is apart from the pages browser, and only it serves rig-file://', () => {
    expect(rigFilesSession()).not.toBe(pagesSession());
    expect((pagesSession() as unknown as { partition: string }).partition).toBe(RIG_PAGES_PARTITION);
    expect((rigFilesSession() as unknown as { partition: string }).partition).toBe(RIG_FILES_PARTITION);
    expect([...new Set(installed)]).toEqual([RIG_FILES_PARTITION]);
  });

  it('gives its web requests a Referer when they have none, and only it', () => {
    rigFilesSession();
    pagesSession();
    expect([...headerHooks.keys()]).toEqual([RIG_FILES_PARTITION]);
    const headers: Record<string, string> = {};
    headerHooks.get(RIG_FILES_PARTITION)!('https://tile.openstreetmap.org/1/0/0.png', headers);
    expect(headers).toEqual({ Referer: 'https://userig.xyz/' });
  });

  it('is where a space file opens, and a web page opens in the pages browser', () => {
    expect(sessionForPage('rig-file://bnd_abc/site/index.html')).toBe(rigFilesSession());
    expect(sessionForPage('https://docs.google.com/document/d/abc/edit')).toBe(pagesSession());
  });

  it("opens an agent's tab on a space file in that profile", async () => {
    vi.useFakeTimers();
    const opening = agentPage('rig-file://bnd_abc/site/index.html');
    await vi.runAllTimersAsync();
    await opening;
    const web = agentPage('https://example.com/');
    await vi.runAllTimersAsync();
    await web;
    vi.useRealTimers();
    expect(windows.map((w) => [w.url, w.session])).toEqual([
      ['rig-file://bnd_abc/site/index.html', rigFilesSession()],
      ['https://example.com/', pagesSession()],
    ]);
  });

  it('counts both profiles as pages, so pins and reading work on space files', () => {
    expect(isPagesBrowserSession(pagesSession())).toBe(true);
    expect(isPagesBrowserSession(rigFilesSession())).toBe(true);
    expect(isPagesBrowserSession({ partition: 'persist:emdash-browser-profile' })).toBe(false);
  });
});
