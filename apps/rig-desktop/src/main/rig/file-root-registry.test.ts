import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RigFileRootRegistry } from './file-root-registry';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const result = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(result);
  return result;
}

async function registered(
  root: string
): Promise<{ registry: RigFileRootRegistry; rootId: string }> {
  const registry = new RigFileRootRegistry();
  const result = await registry.register(root);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('expected root registration to succeed');
  return { registry, rootId: result.data.rootId };
}

describe('RigFileRootRegistry', () => {
  it('canonicalizes a symlinked root', async () => {
    const realRoot = await directory('rig-root-real-');
    const parent = await directory('rig-root-link-');
    const linkedRoot = path.join(parent, 'root');
    await symlink(realRoot, linkedRoot, 'dir');
    const registry = new RigFileRootRegistry();

    const result = await registry.register(linkedRoot);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.canonicalRoot).toBe(await realpath(realRoot));
    expect(registry.get(result.data.rootId)).toBe(result.data.canonicalRoot);
  });

  it('treats a linked Git worktree as its own registered root', async () => {
    const worktree = await directory('rig-root-worktree-');
    const commonGit = await directory('rig-root-common-git-');
    await writeFile(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(commonGit, 'worktrees', 'feature')}\n`
    );
    await mkdir(path.join(worktree, 'src'));
    await writeFile(path.join(worktree, 'src', 'inside.ts'), 'export {};');
    const { registry, rootId } = await registered(worktree);

    await expect(registry.resolveExisting(rootId, 'src/inside.ts')).resolves.toMatchObject({
      success: true,
      data: path.join(await realpath(worktree), 'src', 'inside.ts'),
    });
    await expect(registry.resolveExisting(rootId, '.git')).resolves.toMatchObject({
      success: true,
      data: path.join(await realpath(worktree), '.git'),
    });
  });

  it('rejects absolute, traversal, null-byte, and empty paths', async () => {
    const root = await directory('rig-root-lexical-');
    const { registry, rootId } = await registered(root);
    for (const input of [
      '/tmp/elsewhere',
      'C:\\elsewhere',
      '\\\\server\\share',
      '../x',
      'a/../../x',
      'a\0b',
      '',
    ]) {
      const result = await registry.resolveExisting(rootId, input);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.kind).toBe('invalid-path');
    }
    await expect(registry.resolveExisting(rootId, '', { allowRoot: true })).resolves.toMatchObject({
      success: true,
      data: await realpath(root),
    });
  });

  it('accepts an internal symlink and a missing child for writable resolution', async () => {
    const root = await directory('rig-root-internal-');
    const target = path.join(root, 'target');
    await mkdir(target);
    await writeFile(path.join(target, 'present.txt'), 'ok');
    await symlink('target', path.join(root, 'link'), 'dir');
    const { registry, rootId } = await registered(root);

    await expect(registry.resolveExisting(rootId, 'link/present.txt')).resolves.toMatchObject({
      success: true,
      data: path.join(await realpath(target), 'present.txt'),
    });
    await expect(registry.resolveWritable(rootId, 'link/new.txt')).resolves.toMatchObject({
      success: true,
      data: path.join(await realpath(root), 'link/new.txt'),
    });
  });

  it('rejects an escaping symlink for existing and writable resolutions', async () => {
    const root = await directory('rig-root-escape-');
    const outside = await directory('rig-root-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'escape'), 'dir');
    const { registry, rootId } = await registered(root);

    for (const result of [
      await registry.resolveExisting(rootId, 'escape/secret.txt'),
      await registry.resolveWritable(rootId, 'escape/new.txt'),
    ]) {
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.kind).toBe('outside-root');
    }
  });

  it('rejects a broken symlink instead of treating it as a writable missing tail', async () => {
    const root = await directory('rig-root-broken-');
    const outside = await directory('rig-root-broken-outside-');
    await symlink(path.join(outside, 'missing-target'), path.join(root, 'broken'), 'file');
    const { registry, rootId } = await registered(root);

    const existing = await registry.resolveExisting(rootId, 'broken');
    expect(existing.success).toBe(false);
    const writable = await registry.resolveWritable(rootId, 'broken/child.txt');
    expect(writable.success).toBe(false);
    if (!writable.success) expect(['outside-root', 'io-error']).toContain(writable.error.kind);
  });

  it('rejects symlink loops without hanging', async () => {
    const root = await directory('rig-root-loop-');
    await symlink('b', path.join(root, 'a'), 'dir');
    await symlink('a', path.join(root, 'b'), 'dir');
    const { registry, rootId } = await registered(root);

    await expect(registry.resolveExisting(rootId, 'a/file')).resolves.toMatchObject({
      success: false,
    });
    await expect(registry.resolveWritable(rootId, 'a/file')).resolves.toMatchObject({
      success: false,
    });
  });

  it('distinguishes missing existing targets and stale root ids', async () => {
    const root = await directory('rig-root-missing-');
    const { registry, rootId } = await registered(root);
    await expect(registry.resolveExisting(rootId, 'missing.txt')).resolves.toMatchObject({
      success: false,
      error: { kind: 'not-found' },
    });
    await expect(registry.resolveWritable(rootId, 'missing.txt')).resolves.toMatchObject({
      success: true,
      data: path.join(await realpath(root), 'missing.txt'),
    });
    registry.release(rootId);
    expect(registry.get(rootId)).toBeUndefined();
    await expect(registry.resolveWritable(rootId, 'missing.txt')).resolves.toMatchObject({
      success: false,
      error: { kind: 'stale-root' },
    });
  });

  it('rejects a registered root that was replaced with a symlink', async () => {
    const root = await directory('rig-root-replaced-');
    const outside = await directory('rig-root-replacement-outside-');
    const { registry, rootId } = await registered(root);
    const movedRoot = `${root}-moved`;
    cleanup.push(movedRoot);
    await rename(root, movedRoot);
    await symlink(outside, root, 'dir');

    await expect(registry.resolveWritable(rootId, 'escaped.txt')).resolves.toMatchObject({
      success: false,
      error: { kind: 'stale-root' },
    });
    await expect(registry.getVerified(rootId)).resolves.toMatchObject({
      success: false,
      error: { kind: 'stale-root' },
    });
  });

  it('keeps the capability cap intact across concurrent registrations', async () => {
    const root = await directory('rig-root-cap-');
    const registry = new RigFileRootRegistry();
    const results = await Promise.all(Array.from({ length: 300 }, () => registry.register(root)));

    expect(results.filter((result) => result.success)).toHaveLength(256);
    expect(results.filter((result) => !result.success)).toHaveLength(44);
  });
});
