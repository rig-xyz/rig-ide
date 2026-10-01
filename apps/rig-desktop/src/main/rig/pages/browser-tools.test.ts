import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOLS, type BrowserToolsDeps } from './browser-tools';

// browser_read on a Google editor: the export's full text when there is one,
// else the page as rendered, saying why.

let rendered: unknown = 'Only the part on screen';
const executeJavaScript = vi.fn(async (code: string) => (code.includes('document.body') ? rendered : []));

vi.mock('electron', () => ({}));
vi.mock('./agent-pages', () => ({
  agentPage: async () => ({ getTitle: () => 'Plan - Google Docs', getURL: () => 'https://docs.google.com/document/d/abc/edit' }),
  renderSnapshot: vi.fn(),
}));
vi.mock('./page-frames', () => ({
  contentFrameOf: () => ({ frame: { executeJavaScript }, hop: null }),
  locateOnPage: vi.fn(),
}));

const read = BROWSER_TOOLS.find((t) => t.name === 'browser_read')!;
const URL = 'https://docs.google.com/document/d/abc/edit';
const deps = (fullText?: BrowserToolsDeps['fullText']): BrowserToolsDeps => ({ pinsFor: async () => [], signInWall: async () => null, fullText });
const text = (r: Awaited<ReturnType<typeof read.run>>) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

beforeEach(() => {
  rendered = 'Only the part on screen';
  executeJavaScript.mockClear();
});

describe('browser_read with a Google export', () => {
  it("returns the export's full text, saying so, instead of the DOM", async () => {
    const r = await read.run({ url: URL }, deps(async () => ({ ok: true, label: 'Google Docs', text: '# Plan\n\nAll of it.', truncated: false })));
    expect(text(r)).toBe(`Plan - Google Docs (${URL})\n\n[Full document text via Google Docs export, not just what's on screen.]\n\n# Plan\n\nAll of it.`);
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it('says when the export was cut at the size cap', async () => {
    const r = await read.run({ url: URL }, deps(async () => ({ ok: true, label: 'Google Docs', text: 'abc', truncated: true })));
    expect(text(r)).toMatch(/cut at 1 MB/);
  });

  it('falls back to the page as rendered, with the reason', async () => {
    const r = await read.run({ url: URL }, deps(async () => ({ ok: false, label: 'Google Docs', why: 'Google refused the download (403)' })));
    expect(text(r)).toBe(
      `Plan - Google Docs (${URL})\n\n[No full document text via Google Docs export: Google refused the download (403). This is only what the page renders, which may be just the part on screen.]\n\nOnly the part on screen`
    );
  });

  it('reads any other page as before', async () => {
    const fullText = vi.fn(async () => null);
    const r = await read.run({ url: 'https://example.com/' }, deps(fullText));
    expect(text(r)).toBe(`Plan - Google Docs (${URL})\n\nOnly the part on screen`);
    expect(fullText).toHaveBeenCalledWith('https://example.com/');
  });

  it('a sign-in wall wins: no export is tried', async () => {
    const fullText = vi.fn();
    const r = await read.run({ url: URL }, { ...deps(fullText), signInWall: async () => 'Not signed in.' });
    expect(r).toEqual({ content: [{ type: 'text', text: 'Not signed in.' }], isError: true });
    expect(fullText).not.toHaveBeenCalled();
  });

  it('reading one board skips the export', async () => {
    const fullText = vi.fn();
    await read.run({ url: URL, board: 2 }, deps(fullText));
    expect(fullText).not.toHaveBeenCalled();
  });
});
