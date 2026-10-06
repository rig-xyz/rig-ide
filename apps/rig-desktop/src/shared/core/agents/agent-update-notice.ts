import { resolveActiveInstallation, type AgentInstallationStatus } from './agent-payload';

/** The numeric run of a version string ("0.147.0", "v2.1.149", "codex-cli 0.160.1"), or null when there is none. */
function versionParts(version: string): number[] | null {
  const match = /\d+(?:\.\d+)*/.exec(version);
  return match ? match[0].split('.').map(Number) : null;
}

/**
 * True when `installed` is an older release than `latest`, compared segment by
 * segment ("1.2" equals "1.2.0"). A prerelease suffix is ignored, and a version
 * that can't be read never counts as older.
 */
export function isOlderVersion(installed: string, latest: string): boolean {
  const a = versionParts(installed);
  const b = versionParts(latest);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

export type AgentUpdateNotice =
  | { kind: 'none' }
  /** Rig's own update action manages the copy in use: offer the Update button. */
  | { kind: 'update'; installed: string; latest: string }
  /** Something else owns the copy in use: say where to update it instead of offering a command that wouldn't touch it. */
  | { kind: 'elsewhere'; installed: string; latest: string; hint: string };

/**
 * Whether the agent CLI Rig resolved is behind the latest published release,
 * and which update applies to it. The latest version comes from npm, but the
 * copy in use may belong to another app (the ChatGPT app bundles its own
 * codex) or to Homebrew, whose release can lag npm's; running the npm update
 * would leave that copy as it is.
 */
export function agentUpdateNotice(
  agentName: string,
  status: Pick<AgentInstallationStatus, 'installations' | 'used' | 'latestVersion'>
): AgentUpdateNotice {
  const active = resolveActiveInstallation(status.installations, status.used);
  const installed = active?.version ?? null;
  const latest = active?.latestVersion ?? status.latestVersion;
  if (!active || !installed || !latest || !isOlderVersion(installed, latest)) return { kind: 'none' };

  const appName = /\/([^/]+)\.app\/Contents\//.exec(active.realpath)?.[1];
  if (appName) {
    return { kind: 'elsewhere', installed, latest, hint: `Update the ${appName} app to get a newer ${agentName}.` };
  }
  if (active.provenance.kind === 'homebrew') {
    const ref = active.provenance.managerRef;
    return {
      kind: 'elsewhere',
      installed,
      latest,
      hint: ref ? `Homebrew installed this copy. Update it with brew upgrade ${ref}.` : 'Homebrew installed this copy. Update it with Homebrew.',
    };
  }
  if (active.manageable) return { kind: 'update', installed, latest };
  return {
    kind: 'elsewhere',
    installed,
    latest,
    hint: `Rig didn't install this copy of ${agentName}. Update it the way you installed it.`,
  };
}
