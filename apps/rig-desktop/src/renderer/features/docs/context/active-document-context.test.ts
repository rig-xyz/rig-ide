import { describe, expect, it, vi } from 'vitest';
import type {
  RigContextCreateTargetInput,
  RigContextCreateTargetResult,
} from '@shared/rig/context';
import {
  ActiveDocumentContextRegistry,
  RigDocumentContextController,
} from './active-document-context';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function success(targetRef: string) {
  return { success: true as const, data: { targetRef } };
}

describe('ActiveDocumentContextRegistry', () => {
  it('keeps roots isolated and prevents an old view cleanup from clearing its replacement', () => {
    const registry = new ActiveDocumentContextRegistry();
    const old = registry.activate('/rig-a');
    old.setWholeDocumentRef('old-a');
    const other = registry.activate('/rig-b');
    other.setWholeDocumentRef('whole-b');
    const current = registry.activate('/rig-a');
    current.setWholeDocumentRef('current-a');

    old.dispose();

    expect(registry.getTargetRef('/rig-a')).toBe('current-a');
    expect(registry.getTargetRef('/rig-b')).toBe('whole-b');
  });

  it('uses the whole-document ref while a passage is pending or unavailable', () => {
    const registry = new ActiveDocumentContextRegistry();
    const handle = registry.activate('/rig');
    handle.setWholeDocumentRef('whole');
    handle.setSelectionPending();
    expect(registry.getTargetRef('/rig')).toBe('whole');
    handle.setSelectionRef('passage');
    expect(registry.getTargetRef('/rig')).toBe('passage');
    handle.setSelectionRef(null);
    expect(registry.getTargetRef('/rig')).toBe('whole');
  });
});

describe('RigDocumentContextController', () => {
  it('ignores a late validation result from an older selection', async () => {
    const registry = new ActiveDocumentContextRegistry();
    const first = deferred<ReturnType<typeof success>>();
    const second = deferred<ReturnType<typeof success>>();
    const createTarget = vi.fn((input: RigContextCreateTargetInput) => {
      if (input.anchor === null) return Promise.resolve(success('whole'));
      return input.anchor.exact === 'first' ? first.promise : second.promise;
    });
    const controller = new RigDocumentContextController(
      { root: '/rig', rootId: 'root-1', relativePath: 'docs/spec.md' },
      createTarget,
      registry
    );
    await Promise.resolve();

    controller.setSelection({ exact: 'first' });
    controller.setSelection({ exact: 'second' });
    first.resolve(success('first-ref'));
    await Promise.resolve();
    expect(registry.getTargetRef('/rig')).toBe('whole');

    second.resolve(success('second-ref'));
    await Promise.resolve();
    expect(registry.getTargetRef('/rig')).toBe('second-ref');
    controller.dispose();
  });

  it('falls back without blocking when passage validation fails', async () => {
    const registry = new ActiveDocumentContextRegistry();
    const onFailure = vi.fn();
    const createTarget = vi.fn(
      async (
        input: RigContextCreateTargetInput
      ): Promise<
        | { success: true; data: RigContextCreateTargetResult }
        | { success: false; error: { kind: 'invalidTarget'; message: string } }
      > =>
        input.anchor === null
          ? success('whole')
          : {
              success: false,
              error: { kind: 'invalidTarget', message: 'too large' },
            }
    );
    const controller = new RigDocumentContextController(
      { root: '/rig', rootId: 'root-1', relativePath: 'docs/spec.md' },
      createTarget,
      registry,
      onFailure
    );
    await Promise.resolve();
    controller.setSelection({ exact: 'selected' });
    await Promise.resolve();

    expect(registry.getTargetRef('/rig')).toBe('whole');
    expect(onFailure).toHaveBeenCalledWith({ kind: 'invalidTarget', message: 'too large' });
    controller.dispose();
  });

  it('ignores validation completion after the document unmounts', async () => {
    const registry = new ActiveDocumentContextRegistry();
    const pending = deferred<ReturnType<typeof success>>();
    const controller = new RigDocumentContextController(
      { root: '/rig', rootId: 'root-1', relativePath: 'docs/spec.md' },
      () => pending.promise,
      registry
    );
    controller.dispose();
    pending.resolve(success('late'));
    await Promise.resolve();
    expect(registry.getTargetRef('/rig')).toBeNull();
  });
});
