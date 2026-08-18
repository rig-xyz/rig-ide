import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { googleDocExportUrl, parseGoogleDocId } from '@shared/rig/import-doc';
import {
  claimImportSlug,
  classifyExportResponse,
  convertDocxToMarkdown,
  imageExtension,
  prepareDocxHtmlForMarkdown,
  titleFromContentDisposition,
  uniqueFileName,
  uniqueSlug,
} from './import-doc';

const DOC_ID = '1AbC-dEf_9xYz0123456789abcdefghijklmnopqrstu';

describe('parseGoogleDocId', () => {
  it('parses every docs.google.com/document URL form', () => {
    const variants = [
      `https://docs.google.com/document/d/${DOC_ID}/edit`,
      `https://docs.google.com/document/d/${DOC_ID}/edit#heading=h.abc123`,
      `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing`,
      `https://docs.google.com/document/d/${DOC_ID}/view`,
      `https://docs.google.com/document/d/${DOC_ID}/preview`,
      `https://docs.google.com/document/d/${DOC_ID}`,
      `https://docs.google.com/document/d/${DOC_ID}/`,
      `https://docs.google.com/document/u/1/d/${DOC_ID}/edit`,
      `http://docs.google.com/document/d/${DOC_ID}/edit`,
      // Scheme-less paste, straight out of a chat message.
      `docs.google.com/document/d/${DOC_ID}/edit#heading=h.x`,
      // Surrounding whitespace from a sloppy copy.
      `  https://docs.google.com/document/d/${DOC_ID}/edit  `,
    ];
    for (const url of variants) {
      expect(parseGoogleDocId(url), url).toBe(DOC_ID);
    }
  });

  it('rejects non-document Google links and non-Google links', () => {
    expect(parseGoogleDocId(`https://docs.google.com/spreadsheets/d/${DOC_ID}/edit`)).toBeNull();
    expect(parseGoogleDocId(`https://docs.google.com/presentation/d/${DOC_ID}/edit`)).toBeNull();
    expect(parseGoogleDocId(`https://drive.google.com/file/d/${DOC_ID}/view`)).toBeNull();
    expect(parseGoogleDocId('https://example.com/document/d/abc/edit')).toBeNull();
    expect(parseGoogleDocId('not a url')).toBeNull();
    expect(parseGoogleDocId('')).toBeNull();
    expect(parseGoogleDocId('https://docs.google.com/document/')).toBeNull();
  });

  it('builds the docx export URL — never the HTML page', () => {
    expect(googleDocExportUrl(DOC_ID)).toBe(
      `https://docs.google.com/document/d/${DOC_ID}/export?format=docx`
    );
  });
});

describe('classifyExportResponse', () => {
  const ok = {
    status: 200,
    finalUrl: googleDocExportUrl(DOC_ID),
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };

  it('passes a genuine docx export through', () => {
    expect(classifyExportResponse(ok)).toBeNull();
  });

  it('maps ALL three restriction shapes to the one honest message', () => {
    const restrictedMessage =
      'This doc is restricted. Make it viewable via link (Share → Anyone with the link), or download it as .docx and drop it here.';
    // Redirected into the login flow.
    expect(
      classifyExportResponse({
        status: 200,
        finalUrl: 'https://accounts.google.com/v3/signin/identifier?continue=…',
        contentType: 'text/html; charset=utf-8',
      })
    ).toMatchObject({ kind: 'restricted', message: restrictedMessage });
    // Plain auth statuses.
    expect(classifyExportResponse({ ...ok, status: 401 })).toMatchObject({ kind: 'restricted' });
    expect(classifyExportResponse({ ...ok, status: 403 })).toMatchObject({ kind: 'restricted' });
    // A 200 that is secretly a login/interstitial page.
    expect(
      classifyExportResponse({ ...ok, contentType: 'text/html; charset=utf-8' })
    ).toMatchObject({ kind: 'restricted' });
  });

  it('maps 404 to a wrong-link message and other statuses to a retryable one', () => {
    expect(classifyExportResponse({ ...ok, status: 404 })).toMatchObject({ kind: 'notFound' });
    expect(classifyExportResponse({ ...ok, status: 500 })).toMatchObject({ kind: 'network' });
    expect(classifyExportResponse({ ...ok, status: 429 })).toMatchObject({ kind: 'network' });
  });
});

describe('titleFromContentDisposition', () => {
  it('reads plain and RFC-5987 filenames, stripping .docx', () => {
    expect(titleFromContentDisposition('attachment; filename="My Doc.docx"')).toBe('My Doc');
    expect(
      titleFromContentDisposition("attachment; filename*=UTF-8''Knee%20Ability%20Zero.docx")
    ).toBe('Knee Ability Zero');
    expect(titleFromContentDisposition(null)).toBeNull();
    expect(titleFromContentDisposition('inline')).toBeNull();
  });
});

describe('uniqueSlug', () => {
  it('keeps a free name, suffixes -2, -3… on collisions — never overwrites', () => {
    expect(uniqueSlug('doc', () => false)).toBe('doc');
    const taken = new Set(['doc', 'doc-2']);
    expect(uniqueSlug('doc', (c) => taken.has(c))).toBe('doc-3');
  });
});

describe('uniqueFileName (the Add menu\'s "From file…" copy-collision case)', () => {
  it('keeps a free name as-is', () => {
    expect(uniqueFileName('notes.txt', () => false)).toBe('notes.txt');
  });

  it('suffixes the name before the extension on collisions — extension survives untouched', () => {
    const taken = new Set(['notes.txt', 'notes-2.txt']);
    expect(uniqueFileName('notes.txt', (c) => taken.has(c))).toBe('notes-3.txt');
  });

  it('handles a name with no extension', () => {
    expect(uniqueFileName('README', () => false)).toBe('README');
    expect(uniqueFileName('README', (c) => c === 'README')).toBe('README-2');
  });

  it('handles a multi-dot name — only the final extension is preserved separately', () => {
    expect(uniqueFileName('archive.tar.gz', (c) => c === 'archive.tar.gz')).toBe('archive.tar-2.gz');
  });
});

describe('claimImportSlug (real filesystem — the A5 race fix)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const freshRoot = () => {
    const root = mkdtempSync(joinPath(tmpdir(), 'rig-import-doc-test-'));
    roots.push(root);
    return root;
  };

  it('claims the base slug and its empty assets dir on a clean root', () => {
    const root = freshRoot();
    const { slug, assetsDir } = claimImportSlug(root, 'doc');
    expect(slug).toBe('doc');
    expect(assetsDir).toBe(joinPath(root, 'assets', 'doc'));
    expect(existsSync(assetsDir)).toBe(true);
  });

  it('the core fix: two SEQUENTIAL claims for the same title never collide — the second gets its own reserved slug, not the first\'s directory', () => {
    const root = freshRoot();
    const first = claimImportSlug(root, 'doc');
    const second = claimImportSlug(root, 'doc');
    expect(first.slug).toBe('doc');
    expect(second.slug).toBe('doc-2');
    expect(second.assetsDir).not.toBe(first.assetsDir);
    // Both are real, distinct, already-created directories — not a
    // check-then-write gap where a later write could land in the same
    // folder.
    expect(existsSync(first.assetsDir)).toBe(true);
    expect(existsSync(second.assetsDir)).toBe(true);
  });

  it('a pre-existing assets/<slug> dir (from an earlier, unrelated import) is treated as taken, same as a pre-existing .md file', () => {
    const root = freshRoot();
    // Simulates a prior import that left `assets/doc/` behind but not
    // `doc.md` (e.g. a crash between steps 3 and 4) — the base slug must
    // still be skipped, not silently reused.
    const { assetsDir: firstAssetsDir } = claimImportSlug(root, 'doc');
    writeFileSync(joinPath(root, 'other.md'), '# unrelated');
    const { slug } = claimImportSlug(root, 'doc');
    expect(slug).toBe('doc-2');
    expect(existsSync(firstAssetsDir)).toBe(true); // untouched, not reused
  });

  it('an existing .md file with no matching assets dir still blocks that slug', () => {
    const root = freshRoot();
    writeFileSync(joinPath(root, 'doc.md'), '# already here');
    const { slug } = claimImportSlug(root, 'doc');
    expect(slug).toBe('doc-2');
  });
});

describe('imageExtension', () => {
  it('maps content types to file extensions with a png fallback', () => {
    expect(imageExtension('image/png')).toBe('png');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/gif')).toBe('gif');
    expect(imageExtension('image/svg+xml')).toBe('svg');
    expect(imageExtension(null)).toBe('png');
    expect(imageExtension('nonsense')).toBe('png');
  });
});

describe('prepareDocxHtmlForMarkdown', () => {
  it('promotes the first td-only row to headers and unwraps cell paragraphs', () => {
    const html =
      '<table><tr><td><p>Name</p></td><td><p>Value</p></td></tr><tr><td><p>A</p></td><td><p>B</p></td></tr></table>';
    expect(prepareDocxHtmlForMarkdown(html)).toBe(
      '<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>B</td></tr></table>'
    );
  });

  it('joins multi-paragraph cells with <br /> and leaves real th rows alone', () => {
    expect(prepareDocxHtmlForMarkdown('<table><tr><td><p>a</p><p>b</p></td></tr></table>')).toBe(
      '<table><tr><th>a<br />b</th></tr></table>'
    );
    const withTh = '<table><tr><th>H</th></tr><tr><td>x</td></tr></table>';
    expect(prepareDocxHtmlForMarkdown(withTh)).toBe(withTh);
  });

  it('leaves non-table HTML untouched', () => {
    const html = '<h1>T</h1><p>a <strong>b</strong></p>';
    expect(prepareDocxHtmlForMarkdown(html)).toBe(html);
  });
});

describe('convertDocxToMarkdown (real mammoth + turndown, fixture docx, no network)', () => {
  it('converts headings, inline styles and tables to clean GFM', async () => {
    const buffer = readFileSync(
      fileURLToPath(new URL('./__fixtures__/import-sample.docx', import.meta.url))
    );
    const { markdown, imageCount } = await convertDocxToMarkdown(buffer, () => 'unused');
    expect(markdown).toContain('# Fixture Doc');
    expect(markdown).toContain('## Details');
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('_italics_');
    expect(markdown).toContain('| Name | Value |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| Knee | Ability |');
    expect(markdown.endsWith('\n')).toBe(true);
    expect(imageCount).toBe(0);
  });
});
