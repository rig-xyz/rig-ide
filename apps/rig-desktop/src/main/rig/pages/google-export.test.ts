import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportRedirectAllowed,
  googleExportTarget,
  googleFullText,
  readGoogleExport,
  sameGoogleFile,
  sessionGet,
  type ExportGet,
  type ExportResponse,
} from './google-export';

// Google editors draw on a canvas: rig_browser_read gets the file's own export,
// in the agent tab's session, and never through a sign-in.

/** A fake Electron ClientRequest: the test scripts what the server does once `end()` is called. */
class FakeRequest extends EventEmitter {
  aborted = false;
  followed: string[] = [];
  private pendingRedirect: string | null = null;
  constructor(
    readonly options: Record<string, unknown>,
    private readonly script: (req: FakeRequest) => void
  ) {
    super();
  }
  end() {
    queueMicrotask(() => this.script(this));
  }
  abort() {
    this.aborted = true;
  }
  followRedirect() {
    if (this.pendingRedirect) this.followed.push(this.pendingRedirect);
  }
  redirect(to: string) {
    this.pendingRedirect = to;
    this.emit('redirect', 302, 'GET', to, {});
    this.pendingRedirect = null;
  }
  respond(status: number, contentType: string, chunks: string[]) {
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
    res.statusCode = status;
    res.headers = { 'content-type': contentType };
    this.emit('response', res);
    for (const c of chunks) {
      if (this.aborted) return;
      res.emit('data', Buffer.from(c));
    }
    if (!this.aborted) res.emit('end');
  }
}

const requests: FakeRequest[] = [];
let script: (req: FakeRequest) => void = () => {};

vi.mock('electron', () => ({
  net: {
    request: (options: Record<string, unknown>) => {
      const req = new FakeRequest(options, script);
      requests.push(req);
      return req;
    },
  },
}));

beforeEach(() => {
  requests.length = 0;
  script = () => {};
});

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-xy';

describe('googleExportTarget', () => {
  it('maps a Doc to its markdown export, then plain text', () => {
    expect(googleExportTarget(`https://docs.google.com/document/d/${ID}/edit?tab=t.0#heading=h.1`)).toEqual({
      kind: 'document',
      id: ID,
      label: 'Google Docs',
      urls: [`https://docs.google.com/document/d/${ID}/export?format=md`, `https://docs.google.com/document/d/${ID}/export?format=txt`],
    });
  });

  it("maps a Sheet to CSV of the link's tab: #gid, ?gid, else the first", () => {
    const base = `https://docs.google.com/spreadsheets/d/${ID}`;
    expect(googleExportTarget(`${base}/edit#gid=123456`)?.urls).toEqual([`${base}/export?format=csv&gid=123456`]);
    expect(googleExportTarget(`${base}/edit?gid=42`)?.urls).toEqual([`${base}/export?format=csv&gid=42`]);
    expect(googleExportTarget(`${base}/edit`)?.urls).toEqual([`${base}/export?format=csv`]);
    expect(googleExportTarget(`${base}/edit#gid=nope`)?.urls).toEqual([`${base}/export?format=csv`]);
  });

  it("takes a Sheet's tab from where the page landed, for the same file only", () => {
    const base = `https://docs.google.com/spreadsheets/d/${ID}`;
    expect(googleExportTarget(`${base}/edit`, `${base}/edit#gid=7`)?.urls).toEqual([`${base}/export?format=csv&gid=7`]);
    expect(googleExportTarget(`${base}/edit#gid=1`, `${base}/edit#gid=7`)?.urls).toEqual([`${base}/export?format=csv&gid=1`]);
    expect(googleExportTarget(`${base}/edit`, `https://docs.google.com/spreadsheets/d/${ID}zz/edit#gid=7`)?.urls).toEqual([`${base}/export?format=csv`]);
  });

  it('maps Slides to its text export', () => {
    expect(googleExportTarget(`https://docs.google.com/presentation/d/${ID}/edit#slide=id.p`)?.urls).toEqual([
      `https://docs.google.com/presentation/d/${ID}/export/txt`,
    ]);
  });

  it('keeps the /u/<n>/ account in the export link', () => {
    expect(googleExportTarget(`https://docs.google.com/document/u/1/d/${ID}/edit`)?.urls[0]).toBe(
      `https://docs.google.com/document/u/1/d/${ID}/export?format=md`
    );
    expect(googleExportTarget(`https://docs.google.com/spreadsheets/u/2/d/${ID}/edit#gid=9`)?.urls[0]).toBe(
      `https://docs.google.com/spreadsheets/u/2/d/${ID}/export?format=csv&gid=9`
    );
  });

  it('leaves every other page alone', () => {
    for (const url of [
      'https://example.com/document/d/x/edit',
      `https://example.com/document/d/${ID}/edit`,
      `http://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com/forms/d/${ID}/edit`,
      'https://docs.google.com/document/d/e/2PACX-1vSomething/pub',
      `https://drive.google.com/file/d/${ID}/view`,
      'https://docs.google.com/document/',
      'not a url',
    ]) {
      expect(googleExportTarget(url), url).toBeNull();
    }
  });

  it('knows when two links are the same file', () => {
    expect(sameGoogleFile(`https://docs.google.com/document/d/${ID}/edit`, `https://docs.google.com/document/u/1/d/${ID}/edit?tab=t.0`)).toBe(true);
    expect(sameGoogleFile(`https://docs.google.com/document/d/${ID}/edit`, `https://docs.google.com/spreadsheets/d/${ID}/edit`)).toBe(false);
    expect(sameGoogleFile(`https://docs.google.com/document/d/${ID}/edit`, 'https://accounts.google.com/ServiceLogin')).toBe(false);
  });
});

describe('exportRedirectAllowed', () => {
  it("follows Google's document hosts only, never a sign-in", () => {
    expect(exportRedirectAllowed('https://doc-0s-4c-docs.googleusercontent.com/export/abc')).toBe(true);
    expect(exportRedirectAllowed(`https://docs.google.com/document/d/${ID}/export?format=txt`)).toBe(true);
    expect(exportRedirectAllowed('https://accounts.google.com/ServiceLogin?continue=x')).toBe(false);
    expect(exportRedirectAllowed('http://doc-0s-4c-docs.googleusercontent.com/export/abc')).toBe(false);
    expect(exportRedirectAllowed('https://googleusercontent.com.evil.example/x')).toBe(false);
  });
});

const doc = googleExportTarget(`https://docs.google.com/document/d/${ID}/edit`)!;
const ok = (body: string, contentType = 'text/plain; charset=utf-8', truncated = false): Extract<ExportResponse, { kind: 'response' }> => ({
  kind: 'response',
  status: 200,
  contentType,
  body: Buffer.from(body),
  truncated,
});
const scripted = (...answers: ExportResponse[]) => {
  const get = vi.fn<ExportGet>(async () => answers.shift() ?? { kind: 'error', message: 'unexpected' });
  return get;
};

describe('readGoogleExport', () => {
  it('returns the markdown export', async () => {
    const get = scripted(ok('# Plan\n\nAll of it.', 'text/x-markdown'));
    expect(await readGoogleExport(doc, get)).toEqual({ ok: true, label: 'Google Docs', text: '# Plan\n\nAll of it.', truncated: false });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('falls back to plain text when markdown fails', async () => {
    const get = scripted({ ...ok(''), status: 400 }, ok('﻿Plan\r\nAll of it.'));
    expect(await readGoogleExport(doc, get)).toMatchObject({ ok: true, text: 'Plan\r\nAll of it.' });
    expect(get.mock.calls.map((c) => c[0])).toEqual(doc.urls);
  });

  it('stops at a redirect to sign-in, without trying again', async () => {
    const get = scripted({ kind: 'redirect', to: 'https://accounts.google.com/ServiceLogin?continue=x' }, ok('never'));
    const r = await readGoogleExport(doc, get);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.why).toMatch(/sign-in/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('says why on a 403 (downloads off, or not shared with this account)', async () => {
    const r = await readGoogleExport(doc, scripted({ ...ok('nope', 'text/html'), status: 403 }));
    expect(!r.ok && r.why).toMatch(/403.*turned off downloading.*isn't shared/);
  });

  it('refuses an HTML page in place of the file', async () => {
    const get = scripted(ok('<html>Sign in</html>', 'text/html; charset=utf-8'), ok('<html>Sign in</html>', 'text/html'));
    const r = await readGoogleExport(doc, get);
    expect(!r.ok && r.why).toMatch(/web page instead of the file/);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('gives up after the time limit and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const get = vi.fn<ExportGet>((_url, opts) => {
      signal = opts.signal;
      return new Promise(() => {});
    });
    const r = await readGoogleExport(doc, get, { timeoutMs: 20 });
    expect(!r.ok && r.why).toMatch(/longer than/);
    expect(signal?.aborted).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('passes a cut-off body through, marked truncated', async () => {
    const r = await readGoogleExport(doc, scripted(ok('abc', 'text/plain', true)), { maxBytes: 3 });
    expect(r).toEqual({ ok: true, label: 'Google Docs', text: 'abc', truncated: true });
  });
});

describe('sessionGet and googleFullText', () => {
  const pagesSession = { name: 'pages session' } as unknown as Electron.Session;
  const signal = () => new AbortController().signal;

  it("fetches in the page's own session, with its cookies, following redirects by hand", async () => {
    script = (req) => {
      req.redirect('https://doc-0s-4c-docs.googleusercontent.com/export/abc');
      req.respond(200, 'text/x-markdown', ['# Plan', '\n\nAll of it.']);
    };
    const tab = { getURL: () => `https://docs.google.com/document/d/${ID}/edit?tab=t.0`, session: pagesSession };
    const r = await googleFullText(`https://docs.google.com/document/d/${ID}/edit`, tab);
    expect(r).toEqual({ ok: true, label: 'Google Docs', text: '# Plan\n\nAll of it.', truncated: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.options).toEqual({
      url: `https://docs.google.com/document/d/${ID}/export?format=md`,
      session: pagesSession,
      credentials: 'include',
      redirect: 'manual',
    });
    expect(requests[0]!.followed).toEqual(['https://doc-0s-4c-docs.googleusercontent.com/export/abc']);
  });

  it('never follows a redirect to accounts.google.com', async () => {
    script = (req) => req.redirect('https://accounts.google.com/ServiceLogin?continue=x');
    const r = await sessionGet(pagesSession)('https://docs.google.com/x', { maxBytes: 100, signal: signal() });
    expect(r).toEqual({ kind: 'redirect', to: 'https://accounts.google.com/ServiceLogin?continue=x' });
    expect(requests[0]!.followed).toEqual([]);
    expect(requests[0]!.aborted).toBe(true);
  });

  it('stops reading past the size cap', async () => {
    script = (req) => req.respond(200, 'text/plain', ['abcd', 'efgh', 'ijkl']);
    const r = await sessionGet(pagesSession)('https://docs.google.com/x', { maxBytes: 6, signal: signal() });
    expect(r).toMatchObject({ kind: 'response', status: 200, truncated: true });
    expect(r.kind === 'response' && r.body.toString()).toBe('abcdef');
    expect(requests[0]!.aborted).toBe(true);
  });

  it('aborts the request when the signal fires', async () => {
    const ctl = new AbortController();
    const pending = sessionGet(pagesSession)('https://docs.google.com/x', { maxBytes: 6, signal: ctl.signal });
    ctl.abort();
    expect(await pending).toEqual({ kind: 'error', message: 'aborted' });
    expect(requests[0]!.aborted).toBe(true);
  });

  it('does nothing for a page that is not a Google editor', async () => {
    const tab = { getURL: () => 'https://example.com/', session: pagesSession };
    expect(await googleFullText('https://example.com/', tab)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("doesn't export when the tab didn't land on the file", async () => {
    const tab = { getURL: () => 'https://accounts.google.com/ServiceLogin', session: pagesSession };
    const r = await googleFullText(`https://docs.google.com/document/d/${ID}/edit`, tab);
    expect(r).toMatchObject({ ok: false, label: 'Google Docs' });
    expect(requests).toHaveLength(0);
  });
});
