import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyToDownloads, downloadsName } from './save-to-downloads';

describe('downloadsName', () => {
  it('keeps the name first, then numbers it before the extension', () => {
    expect(downloadsName('report.pdf', 1)).toBe('report.pdf');
    expect(downloadsName('report.pdf', 2)).toBe('report 2.pdf');
    expect(downloadsName('report.pdf', 3)).toBe('report 3.pdf');
    expect(downloadsName('archive.tar.gz', 2)).toBe('archive.tar 2.gz');
  });

  it('numbers a name with no extension at the end', () => {
    expect(downloadsName('Makefile', 2)).toBe('Makefile 2');
    expect(downloadsName('.env', 2)).toBe('.env 2');
  });
});

describe('copyToDownloads', () => {
  let base: string;
  let downloads: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'save-to-downloads-'));
    downloads = join(base, 'Downloads');
    mkdirSync(downloads);
    mkdirSync(join(base, 'space'));
    writeFileSync(join(base, 'space', 'notes.md'), 'mine');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('copies under the same name, then " 2", " 3", never over what is there', async () => {
    writeFileSync(join(downloads, 'notes 2.md'), 'theirs');
    expect(await copyToDownloads(join(base, 'space', 'notes.md'), downloads)).toBe(join(downloads, 'notes.md'));
    expect(await copyToDownloads(join(base, 'space', 'notes.md'), downloads)).toBe(join(downloads, 'notes 3.md'));
    expect(readFileSync(join(downloads, 'notes 2.md'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(downloads, 'notes 3.md'), 'utf8')).toBe('mine');
    expect(readdirSync(downloads).sort()).toEqual(['notes 2.md', 'notes 3.md', 'notes.md']);
  });

  it('copies a folder whole', async () => {
    mkdirSync(join(base, 'space', 'site'));
    writeFileSync(join(base, 'space', 'site', 'index.html'), '<p>hi</p>');
    mkdirSync(join(downloads, 'site'));
    const dest = await copyToDownloads(join(base, 'space', 'site'), downloads);
    expect(dest).toBe(join(downloads, 'site 2'));
    expect(readFileSync(join(dest, 'index.html'), 'utf8')).toBe('<p>hi</p>');
  });
});
