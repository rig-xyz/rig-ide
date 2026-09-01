import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeRigContextTarget } from '@shared/rig/context';
import { createRigContextTarget } from './context';
import { rigFileRootRegistry } from './file-root-registry';

const cleanup: Array<{ root: string; rootId?: string }> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0)) {
    if (item.rootId) rigFileRootRegistry.release(item.rootId);
    await rm(item.root, { recursive: true, force: true });
  }
});

async function makeWorkspace(
  bindingId: string | null = 'bnd_context_1'
): Promise<{ root: string; rootId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'rig-context-'));
  cleanup.push({ root });
  if (bindingId) {
    await mkdir(path.join(root, '.rig'), { recursive: true });
    await writeFile(
      path.join(root, '.rig', 'tap-binding.local.json'),
      JSON.stringify({
        bindingId,
        relayUrl: 'https://relay.example.test',
        deviceId: 'dev_context_1',
        token: 'tap_cap_context_1',
      })
    );
  }
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'spec.md'), '# Spec\nShip the focused workflow.\n');
  const registered = await rigFileRootRegistry.register(root);
  expect(registered.success).toBe(true);
  if (!registered.success) throw new Error('workspace root registration failed');
  cleanup[cleanup.length - 1]!.rootId = registered.data.rootId;
  return { root, rootId: registered.data.rootId };
}

describe('createRigContextTarget', () => {
  it('validates the registered file and derives binding and manifest path in main', async () => {
    const { rootId } = await makeWorkspace();
    const result = await createRigContextTarget({
      rootId,
      relativePath: 'docs/spec.md',
      anchor: {
        exact: 'focused workflow',
        prefix: 'Ship the ',
        suffix: '.\n',
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(decodeRigContextTarget(result.data.targetRef)).toEqual({
      success: true,
      data: {
        version: 1,
        workspaceBindingId: 'bnd_context_1',
        path: 'docs/spec.md',
        anchor: {
          exact: 'focused workflow',
          prefix: 'Ship the ',
          suffix: '.\n',
        },
      },
    });
  });

  it('rejects traversal, missing files, directories, and oversized anchors', async () => {
    const { rootId } = await makeWorkspace();
    for (const input of [
      { rootId, relativePath: '../outside.md', anchor: null },
      { rootId, relativePath: 'docs/missing.md', anchor: null },
      { rootId, relativePath: 'docs', anchor: null },
      { rootId, relativePath: 'docs/spec.md', anchor: { exact: 'x'.repeat(2001) } },
    ]) {
      expect((await createRigContextTarget(input)).success).toBe(false);
    }
  });

  it('rejects unbound workspaces and stale root capabilities', async () => {
    const unbound = await makeWorkspace(null);
    await expect(
      createRigContextTarget({
        rootId: unbound.rootId,
        relativePath: 'docs/spec.md',
        anchor: null,
      })
    ).resolves.toMatchObject({ success: false, error: { kind: 'notBound' } });

    const bound = await makeWorkspace();
    rigFileRootRegistry.release(bound.rootId);
    await expect(
      createRigContextTarget({
        rootId: bound.rootId,
        relativePath: 'docs/spec.md',
        anchor: null,
      })
    ).resolves.toMatchObject({ success: false, error: { kind: 'staleRoot' } });
  });
});
