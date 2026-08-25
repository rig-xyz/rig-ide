import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { googleDocExportUrl, parseGoogleDocId } from '@shared/rig/import-doc';
import { rigFileRootRegistry } from './file-root-registry';
import {
  claimImportSlug,
  classifyExportResponse,
  convertDocxToMarkdown,
  imageExtension,
  prepareDocxHtmlForMarkdown,
  titleFromContentDisposition,
  uniqueFileName,
  uniqueSlug,
  rigImportController,
} from './import-doc';

const DOC_ID = '1AbC-dEf_9xYz0123456789abcdefghijklmnopqrstu';

describe('rigImportController root containment', () => {
  it('rejects a stale root handle before reading or writing', async () => {
    await expect(
      rigImportController.importDoc({
        rootId: 'stale-root',
        source: { kind: 'file', path: '/tmp/should-not-be-read.docx' },
      })
    ).resolves.toMatchObject({
      success: false,
      error: { kind: 'invalidRoot' },
    });
  });

  it('copies a selected file only into the registered root', async () => {
    const root = mkdtempSync(joinPath(tmpdir(), 'rig-import-root-'));
    const sourceDir = mkdtempSync(joinPath(tmpdir(), 'rig-import-source-'));
    const source = joinPath(sourceDir, 'notes.txt');
    writeFileSync(source, 'hello');
    const registered = await rigFileRootRegistry.register(root);
    expect(registered.success).toBe(true);
    if (!registered.success) return;
    try {
      await expect(
        rigImportController.copyFile({ rootId: registered.data.rootId, path: source })
      ).resolves.toEqual({ success: true, data: { relPath: 'notes.txt' } });
      expect(readFileSync(joinPath(root, 'notes.txt'), 'utf8')).toBe('hello');
    } finally {
      rigFileRootRegistry.release(registered.data.rootId);
      rmSync(root, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('rejects an assets symlink that would send an import outside the root', async () => {
    const root = mkdtempSync(joinPath(tmpdir(), 'rig-import-root-'));
    const outside = mkdtempSync(joinPath(tmpdir(), 'rig-import-outside-'));
    symlinkSync(outside, joinPath(root, 'assets'), 'dir');
    const registered = await rigFileRootRegistry.register(root);
    expect(registered.success).toBe(true);
    if (!registered.success) return;
    try {
      await expect(claimImportSlug(registered.data.rootId, 'doc')).resolves.toMatchObject({
        success: false,
        error: { kind: 'writeFailed' },
      });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rigFileRootRegistry.release(registered.data.rootId);
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

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
    expect(uniqueFileName('archive.tar.gz', (c) => c === 'archive.tar.gz')).toBe(
      'archive.tar-2.gz'
    );
  });
});

describe('claimImportSlug (real filesystem — the A5 race fix)', () => {
  const roots: Array<{ root: string; rootId: string }> = [];
  afterEach(() => {
    for (const entry of roots.splice(0)) {
      rigFileRootRegistry.release(entry.rootId);
      rmSync(entry.root, { recursive: true, force: true });
    }
  });
  const freshRoot = async () => {
    const root = mkdtempSync(joinPath(tmpdir(), 'rig-import-doc-test-'));
    const registered = await rigFileRootRegistry.register(root);
    if (!registered.success) throw new Error(registered.error.message);
    const value = { root, rootId: registered.data.rootId };
    roots.push(value);
    return value;
  };

  it('claims the base slug and its empty assets dir on a clean root', async () => {
    const { root, rootId } = await freshRoot();
    const result = await claimImportSlug(rootId, 'doc');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.slug).toBe('doc');
    expect(result.data.assetsRel).toBe('assets/doc');
    expect(existsSync(joinPath(root, result.data.assetsRel))).toBe(true);
  });

  it("the core fix: two SEQUENTIAL claims for the same title never collide — the second gets its own reserved slug, not the first's directory", async () => {
    const { rootId } = await freshRoot();
    const first = await claimImportSlug(rootId, 'doc');
    const second = await claimImportSlug(rootId, 'doc');
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.data.slug).toBe('doc');
    expect(second.data.slug).toBe('doc-2');
    expect(second.data.assetsRel).not.toBe(first.data.assetsRel);
    // Both are real, distinct, already-created directories — not a
    // check-then-write gap where a later write could land in the same
    // folder.
    const root = rigFileRootRegistry.get(rootId);
    expect(root).toBeDefined();
    if (!root) return;
    expect(existsSync(joinPath(root, first.data.assetsRel))).toBe(true);
    expect(existsSync(joinPath(root, second.data.assetsRel))).toBe(true);
  });

  it('a pre-existing assets/<slug> dir (from an earlier, unrelated import) is treated as taken, same as a pre-existing .md file', async () => {
    const { root, rootId } = await freshRoot();
    // Simulates a prior import that left `assets/doc/` behind but not
    // `doc.md` (e.g. a crash between steps 3 and 4) — the base slug must
    // still be skipped, not silently reused.
    const first = await claimImportSlug(rootId, 'doc');
    if (!first.success) return;
    const firstAssetsDir = joinPath(root, first.data.assetsRel);
    writeFileSync(joinPath(root, 'other.md'), '# unrelated');
    const second = await claimImportSlug(rootId, 'doc');
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.slug).toBe('doc-2');
    expect(existsSync(firstAssetsDir)).toBe(true); // untouched, not reused
  });

  it('an existing .md file with no matching assets dir still blocks that slug', async () => {
    const { root, rootId } = await freshRoot();
    writeFileSync(joinPath(root, 'doc.md'), '# already here');
    const result = await claimImportSlug(rootId, 'doc');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.slug).toBe('doc-2');
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
