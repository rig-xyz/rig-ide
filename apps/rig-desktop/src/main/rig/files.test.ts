import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rigFilesController } from './files';

/**
 * Round (beyond-markdown): `readBinary` is new — a true partial read (not
 * `readFile` sliced afterward) backing both the image viewer and the
 * binary sniff on an unrecognized extension. Real filesystem, same
 * tmpdir-per-test convention `import-doc.test.ts`'s `claimImportSlug`
 * suite already established.
 */
describe('rigFilesController.readBinary', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const freshDir = () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'rig-files-test-'));
    dirs.push(dir);
    return dir;
  };

  it('reads a small file whole, unset truncated, and reports its real size', async () => {
    const dir = freshDir();
    const path = joinPath(dir, 'small.bin');
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    writeFileSync(path, bytes);

    const result = await rigFilesController.readBinary(path, 4096);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.truncated).toBe(false);
    expect(result.data.size).toBe(5);
    expect(Buffer.from(result.data.data, 'base64')).toEqual(bytes);
  });

  it('a genuine PARTIAL read for a file larger than maxBytes — only the first N bytes come back, truncated is true, size is still the REAL total', async () => {
    const dir = freshDir();
    const path = joinPath(dir, 'large.bin');
    const bytes = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 256));
    writeFileSync(path, bytes);

    const result = await rigFilesController.readBinary(path, 100);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.truncated).toBe(true);
    expect(result.data.size).toBe(10_000);
    const decoded = Buffer.from(result.data.data, 'base64');
    expect(decoded.length).toBe(100);
    expect(decoded).toEqual(bytes.subarray(0, 100));
  });

  it('a null byte survives the round trip intact — the binary sniff depends on this', async () => {
    const dir = freshDir();
    const path = joinPath(dir, 'withnull.bin');
    const bytes = Buffer.from([72, 101, 0, 108, 111]);
    writeFileSync(path, bytes);

    const result = await rigFilesController.readBinary(path, 4096);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Buffer.from(result.data.data, 'base64')).toEqual(bytes);
  });

  it('an empty file — no read attempted, still succeeds with size 0', async () => {
    const dir = freshDir();
    const path = joinPath(dir, 'empty.bin');
    writeFileSync(path, Buffer.alloc(0));

    const result = await rigFilesController.readBinary(path, 4096);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.size).toBe(0);
    expect(result.data.truncated).toBe(false);
    expect(result.data.data).toBe('');
  });

  it('a missing file — notFound, not a thrown exception', async () => {
    const dir = freshDir();
    const result = await rigFilesController.readBinary(joinPath(dir, 'nope.bin'), 4096);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe('notFound');
  });

  it('a directory (not a file) — notFound, never attempts to read it as bytes', async () => {
    const dir = freshDir();
    const result = await rigFilesController.readBinary(dir, 4096);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe('notFound');
  });
});

/**
 * Navigator v2 (§3.3's row context menu "Rename"): a minimal, real-filesystem
 * `fs.rename` scoped to an entry's own parent directory. Same tmpdir-per-test
 * convention as `readBinary` above.
 */
describe('rigFilesController.rename', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const freshDir = () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'rig-files-rename-test-'));
    dirs.push(dir);
    return dir;
  };

  it('renames a file in place, within its own parent directory', async () => {
    const dir = freshDir();
    const original = joinPath(dir, 'draft.md');
    writeFileSync(original, 'hello');

    const result = await rigFilesController.rename(original, 'final.md');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.path).toBe(joinPath(dir, 'final.md'));
    expect(existsSync(original)).toBe(false);
    expect(existsSync(joinPath(dir, 'final.md'))).toBe(true);
  });

  it('renames a folder in place too — fs.rename works identically on either', async () => {
    const dir = freshDir();
    const original = joinPath(dir, 'old-folder');
    mkdirSync(original);
    writeFileSync(joinPath(original, 'inside.md'), 'x');

    const result = await rigFilesController.rename(original, 'new-folder');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(existsSync(joinPath(dir, 'new-folder', 'inside.md'))).toBe(true);
  });

  it('never overwrites an existing target — alreadyExists, and the original is left untouched', async () => {
    const dir = freshDir();
    const original = joinPath(dir, 'draft.md');
    const target = joinPath(dir, 'final.md');
    writeFileSync(original, 'draft content');
    writeFileSync(target, 'final content');

    const result = await rigFilesController.rename(original, 'final.md');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe('alreadyExists');
    expect(existsSync(original)).toBe(true);
  });

  it('rejects an empty name', async () => {
    const dir = freshDir();
    const original = joinPath(dir, 'draft.md');
    writeFileSync(original, 'hello');

    const result = await rigFilesController.rename(original, '   ');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe('invalidName');
  });

  it('rejects a name carrying a path separator — the traversal guard', async () => {
    const dir = freshDir();
    const original = joinPath(dir, 'draft.md');
    writeFileSync(original, 'hello');

    const result = await rigFilesController.rename(original, '../escaped.md');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe('invalidName');
  });

  it('rejects a bare ".." or "." as a name', async () => {
    const dir = freshDir();
    const original = joinPath(dir, 'draft.md');
    writeFileSync(original, 'hello');

    for (const bad of ['..', '.']) {
      const result = await rigFilesController.rename(original, bad);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.kind).toBe('invalidName');
    }
  });

  it('renaming to the exact same name is a harmless no-op success', async () => {
    const dir = freshDir();
    const original = joinPath(dir, 'draft.md');
    writeFileSync(original, 'hello');

    const result = await rigFilesController.rename(original, 'draft.md');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(existsSync(original)).toBe(true);
  });

  it('a missing source file — notFound, not a thrown exception', async () => {
    const dir = freshDir();
    const result = await rigFilesController.rename(joinPath(dir, 'nope.md'), 'renamed.md');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe('notFound');
  });
});
