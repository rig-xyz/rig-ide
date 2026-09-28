import type { DependencyId } from '@emdash/core/deps/runtime';
import {
  checkLocalBinaryCompat,
  resolveAllCommandPaths,
  resolveCommandPath,
} from '@emdash/core/deps/runtime';
import type { IHostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';

/**
 * Per-context cache: keyed by `${connectionId ?? 'local'}:${providerId}` → resolved absolute path.
 * Populated on first successful resolution; cleared when a new installation is triggered.
 */
const resolvedPathCache = new Map<string, string>();

export function clearResolvedPathCache(providerId: string, connectionId?: string): void {
  resolvedPathCache.delete(cacheKey(providerId, connectionId));
}

function cacheKey(providerId: string, connectionId?: string): string {
  return `${connectionId ?? 'local'}:${providerId}`;
}

/** False only for a local binary built for a processor this machine can't run. */
async function canRunHere(path: string, ctx: IExecutionContext): Promise<boolean> {
  if (!ctx.supportsLocalSpawn) return true;
  return (await checkLocalBinaryCompat(path)).runnable;
}

async function firstRunnableOnPath(binaryName: string, ctx: IExecutionContext): Promise<string | null> {
  for (const candidate of await resolveAllCommandPaths(binaryName, ctx)) {
    if (await canRunHere(candidate, ctx)) return candidate;
  }
  return null;
}

/**
 * Resolve the absolute path of the agent binary to use for conversation spawns.
 *
 * Resolution order:
 * 1. selection.kind === 'pinned': use selection.realpath if it exists on disk; otherwise fall through.
 * 2. selection.kind === 'path': use selection.path if it exists on disk; otherwise fall through.
 * 3. selection.kind === 'cli': return selection.command as-is (PTY resolves on PATH).
 * 4. selection.kind === 'method' or 'auto' (no override): fall through to cachedStatePath.
 * 5. auto:
 *    a. In-memory cached path from dependency probe (cachedStatePath).
 *    b. Probe via ctx (resolveCommandPath).
 *    c. Bare binaryName.
 *    d. providerId as last resort.
 */
export async function resolveAgentExecutable({
  providerId,
  binaryName,
  ctx,
  hostDependencyStore,
  cachedStatePath,
  connectionId,
}: {
  providerId: string;
  binaryName: string;
  ctx: IExecutionContext;
  /** Store for reading the persisted host-scoped installation selection. */
  hostDependencyStore: IHostDependencyStore;
  /** The absolute path the dependency manager resolved during its last probe, if available. */
  cachedStatePath?: string | null;
  connectionId?: string;
}): Promise<string> {
  const hostId = connectionId ?? 'local';
  const selection = await hostDependencyStore.getSelection(hostId, providerId as DependencyId);

  if (selection?.kind === 'pinned') {
    const exists = await resolveCommandPath(selection.realpath, ctx);
    if (exists) return selection.realpath;
    log.warn(
      `[resolveAgentExecutable] Pinned realpath "${selection.realpath}" for ${providerId} not found — falling back to auto-resolution`
    );
  }

  if (selection?.kind === 'path') {
    const exists = await resolveCommandPath(selection.path, ctx);
    if (exists) return selection.path;
    log.warn(
      `[resolveAgentExecutable] Saved path "${selection.path}" for ${providerId} not found — falling back to auto-resolution`
    );
  }

  if (selection?.kind === 'cli') {
    return selection.command;
  }

  // Auto-resolution with in-memory cache
  const key = cacheKey(providerId, connectionId);
  const cached = resolvedPathCache.get(key);
  if (cached) return cached;

  // Use the dependency manager's in-memory probe result if available
  if (cachedStatePath && (await canRunHere(cachedStatePath, ctx))) {
    resolvedPathCache.set(key, cachedStatePath);
    return cachedStatePath;
  }

  // Live resolution via execution context
  const resolved = await resolveCommandPath(binaryName, ctx);
  if (resolved) {
    // The PATH winner may be a build this Mac can't run (e.g. Intel-only
    // without Rosetta); prefer a runnable copy further down PATH.
    const runnable = (await canRunHere(resolved, ctx))
      ? resolved
      : await firstRunnableOnPath(binaryName, ctx);
    if (runnable) {
      resolvedPathCache.set(key, runnable);
      return runnable;
    }
    return resolved;
  }

  log.warn(
    `[resolveAgentExecutable] Could not resolve binary "${binaryName}" for ${providerId} — using bare name`
  );
  return binaryName || providerId;
}
