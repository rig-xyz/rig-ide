import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rigFileRootRegistry } from './file-root-registry';
import { rigFilesController } from './files';

const dirs: string[] = [];
const rootIds: string[] = [];
afterEach(() => {
  for (const rootId of rootIds.splice(0)) rigFilesController.releaseRoot({ rootId });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function root() {
  const dir = mkdtempSync(join(tmpdir(), 'rig-files-test-'));
  dirs.push(dir);
  const registered = await rigFileRootRegistry.register(dir);
  if (!registered.success) throw new Error(registered.error.message);
  rootIds.push(registered.data.rootId);
  return { dir, rootId: registered.data.rootId };
}

describe('rigFilesController', () => {
  it('lists and reads using an opaque root id', async () => {
    const { dir, rootId } = await root();
    writeFileSync(join(dir, 'hello.md'), 'hello');
    const listed = await rigFilesController.list({ rootId });
    expect(listed.success).toBe(true);
    const read = await rigFilesController.read({ rootId, relativePath: 'hello.md' });
    expect(read).toMatchObject({ success: true, data: { content: 'hello', truncated: false } });
  });

  it('bounds text reads in bytes without returning a broken UTF-8 character', async () => {
    const { dir, rootId } = await root();
    writeFileSync(join(dir, 'unicode.txt'), 'éx');

    await expect(
      rigFilesController.read({ rootId, relativePath: 'unicode.txt', maxBytes: 1 })
    ).resolves.toMatchObject({ success: true, data: { content: '', truncated: true } });
    await expect(
      rigFilesController.read({ rootId, relativePath: 'unicode.txt', maxBytes: 2 })
    ).resolves.toMatchObject({ success: true, data: { content: 'é', truncated: true } });
  });

  it.each(['../escape', '/tmp/escape', 'dir/../../escape'])(
    'rejects unsafe path %s',
    async (relativePath) => {
      const { rootId } = await root();
      const result = await rigFilesController.read({ rootId, relativePath });
      expect(result.success).toBe(false);
      if (!result.success) expect(['invalidPath', 'outsideRoot']).toContain(result.error.kind);
    }
  );

  it('rejects a symlink that escapes the root for reads and writes', async () => {
    const { dir, rootId } = await root();
    const outside = mkdtempSync(join(tmpdir(), 'rig-files-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(dir, 'escape'));
    const read = await rigFilesController.read({ rootId, relativePath: 'escape/secret.txt' });
    const write = await rigFilesController.write({
      rootId,
      relativePath: 'escape/new.txt',
      content: 'x',
    });
    expect(read.success).toBe(false);
    expect(write.success).toBe(false);
  });

  it('renames and archives within the root, returning relative paths', async () => {
    const { dir, rootId } = await root();
    writeFileSync(join(dir, 'draft.md'), 'draft');
    const renamed = await rigFilesController.rename({
      rootId,
      relativePath: 'draft.md',
      newName: 'final.md',
    });
    expect(renamed).toMatchObject({ success: true, data: { relativePath: 'final.md' } });
    const archived = await rigFilesController.archive({ rootId, relativePath: 'final.md' });
    expect(archived.success).toBe(true);
    if (archived.success) expect(archived.data.relativePath).toBe('_archive/final.md');
    expect(readFileSync(join(dir, '_archive/final.md'), 'utf8')).toBe('draft');
  });

  it('rejects rename and archive of a symlink entry instead of moving its target', async () => {
    const { dir, rootId } = await root();
    writeFileSync(join(dir, 'target.md'), 'target');
    symlinkSync('target.md', join(dir, 'link.md'));

    await expect(
      rigFilesController.rename({ rootId, relativePath: 'link.md', newName: 'renamed.md' })
    ).resolves.toMatchObject({ success: false, error: { kind: 'invalidPath' } });
    await expect(
      rigFilesController.archive({ rootId, relativePath: 'link.md' })
    ).resolves.toMatchObject({ success: false, error: { kind: 'invalidPath' } });
    expect(readFileSync(join(dir, 'target.md'), 'utf8')).toBe('target');
    expect(existsSync(join(dir, 'link.md'))).toBe(true);
  });

  it('returns a normalized relative path after writing', async () => {
    const { dir, rootId } = await root();
    mkdirSync(join(dir, 'notes'));
    await expect(
      rigFilesController.write({
        rootId,
        relativePath: 'notes/./saved.md',
        content: 'saved',
      })
    ).resolves.toEqual({ success: true, data: { relativePath: 'notes/saved.md' } });
  });

  it('creates a directory and rejects rename traversal', async () => {
    const { dir, rootId } = await root();
    const made = await rigFilesController.makeDirectory({ rootId, name: 'notes' });
    expect(made).toMatchObject({ success: true, data: { relativePath: 'notes' } });
    mkdirSync(join(dir, 'draft'));
    const bad = await rigFilesController.rename({
      rootId,
      relativePath: 'draft',
      newName: '../escape',
    });
    expect(bad).toMatchObject({ success: false, error: { kind: 'invalidName' } });
  });

  it('release invalidates the root and makes watch-after-release fail', async () => {
    const { rootId } = await root();
    expect((await rigFilesController.watch({ rootId })).success).toBe(true);
    expect(rigFilesController.releaseRoot({ rootId }).success).toBe(true);
    await expect(rigFilesController.watch({ rootId })).resolves.toMatchObject({
      success: false,
      error: { kind: 'staleRoot' },
    });
    expect(rigFilesController.unwatch({ rootId }).success).toBe(true);
    expect(rigFilesController.releaseRoot({ rootId }).success).toBe(true);
  });
});
