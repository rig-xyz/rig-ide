import { stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  encodeRigContextTarget,
  rigContextCreateTargetInputSchema,
  type RigContextCreateTargetError,
  type RigContextCreateTargetResult,
} from '@shared/rig/context';
import { resolveCommentTarget } from './comments';
import { rigFileRootRegistry, type RigFileRootErrorKind } from './file-root-registry';

function failure(
  kind: RigContextCreateTargetError['kind'],
  message: string
): Result<RigContextCreateTargetResult, RigContextCreateTargetError> {
  return err({ kind, message });
}

function mapRootError(kind: RigFileRootErrorKind): RigContextCreateTargetError['kind'] {
  switch (kind) {
    case 'stale-root':
      return 'staleRoot';
    case 'not-found':
      return 'notFound';
    case 'outside-root':
      return 'outsideRoot';
    case 'invalid-root':
    case 'invalid-path':
      return 'invalidTarget';
    case 'io-error':
      return 'ioError';
  }
}

/**
 * Validate a renderer-selected document against the main-owned root
 * capability, then mint a credential-free target locator for one prompt.
 */
export async function createRigContextTarget(
  rawInput: unknown
): Promise<Result<RigContextCreateTargetResult, RigContextCreateTargetError>> {
  const input = rigContextCreateTargetInputSchema.safeParse(rawInput);
  if (!input.success) return failure('invalidTarget', 'Document context target is invalid.');

  const existing = await rigFileRootRegistry.resolveExisting(
    input.data.rootId,
    input.data.relativePath
  );
  if (!existing.success) {
    return failure(mapRootError(existing.error.kind), existing.error.message);
  }
  try {
    if (!(await stat(existing.data)).isFile()) {
      return failure('notFound', 'Document context target is not a file.');
    }
  } catch {
    return failure('ioError', 'Document context target is not available.');
  }

  // Preserve the manifest path the renderer opened rather than the final
  // realpath of an allowed in-root symlink. resolveExisting above has already
  // proved the lexical path cannot escape the registered root.
  const root = await rigFileRootRegistry.getVerified(input.data.rootId);
  if (!root.success) return failure(mapRootError(root.error.kind), root.error.message);
  const target = resolveCommentTarget(path.join(root.data, input.data.relativePath));
  if (!target) return failure('notBound', 'Document is not inside a synced Rig workspace.');

  const encoded = encodeRigContextTarget({
    version: 1,
    workspaceBindingId: target.bindingId,
    path: target.relPath,
    anchor: input.data.anchor,
  });
  if (!encoded.success) return failure(encoded.error.kind, encoded.error.message);
  return ok({ targetRef: encoded.data });
}

export const rigContextController = createRPCController({
  createTarget: createRigContextTarget,
});
