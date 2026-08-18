import type { CLIAgentPluginProvider } from '../agents/plugins';
import type { DependencyDescriptor, DependencyStatus, ProbeResult } from './runtime';

/**
 * The default `resolveStatus` for every agent that doesn't supply its own —
 * i.e. every agent that goes through `buildDescriptorFromProvider` at all,
 * since the fallback below is what `resolveStatus` becomes when a provider's
 * behavior doesn't override it. This always wins over
 * `host-dependency-manager.ts`'s own `resolveProbeStatus` fallback (it checks
 * `descriptor.resolveStatus` first and returns immediately if set) — so this
 * function, not that one, is what actually decides every agent's status.
 *
 * Requires a passing probe before calling a resolved path 'available', for
 * the same reason `resolveProbeStatus`'s fallback does: a `which` match only
 * proves a binary is *named* right, not that it runs (or that it's the binary
 * the reader thinks it is — a PATH name collision with an unrelated program
 * of the same name looks identical to a working install right up until the
 * moment something tries to actually run it as this agent). This used to
 * return 'available' the instant a path resolved, without reading `result`
 * at all — the exact bug the sibling fallback was fixed for, left
 * unfixed here because this override shadows it for every agent.
 */
export function agentResolveStatus(result: ProbeResult): DependencyStatus {
  if (result.path !== null) {
    if (result.exitCode === 0) return 'available';
    if (result.timedOut && result.stdout) return 'available';
    return 'error';
  }
  if (result.timedOut && result.stdout) return 'available';
  if (result.exitCode !== null && (result.stdout || result.stderr)) return 'available';
  return result.exitCode === null ? 'missing' : 'error';
}

export function buildDescriptorFromProvider(
  provider: CLIAgentPluginProvider
): DependencyDescriptor {
  const { metadata, capabilities, behavior } = provider;
  const hostDep = capabilities.hostDependency;
  const binaryNames = hostDep.binaryNames;
  const commandHooks = behavior.hostDependency
    ? {
        resolveLatestVersion: behavior.hostDependency.resolveLatestVersion?.bind(
          behavior.hostDependency
        ),
        buildUpdateCommand: behavior.hostDependency.buildUpdateCommand?.bind(
          behavior.hostDependency
        ),
        buildUninstallCommand: behavior.hostDependency.buildUninstallCommand?.bind(
          behavior.hostDependency
        ),
      }
    : undefined;

  return {
    id: metadata.id,
    name: metadata.name,
    category: 'agent',
    commands: binaryNames.length > 0 ? binaryNames : [metadata.id],
    skipVersionProbe: hostDep.skipVersionProbe,
    versionArgs: hostDep.versionArgs,
    docUrl: metadata.websiteUrl,
    resolveStatus: behavior.hostDependency?.resolveStatus
      ? behavior.hostDependency.resolveStatus.bind(behavior.hostDependency)
      : agentResolveStatus,
    updates: hostDep.updates,
    installCommands: hostDep.installCommands,
    uninstall: hostDep.uninstall,
    commandHooks,
  };
}
