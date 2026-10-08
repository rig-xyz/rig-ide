import { resolveActiveInstallation, type AgentInstallationStatus } from './agent-payload';
import { agentUpdateNotice, isOlderVersion } from './agent-update-notice';

/**
 * Why an agent can't work for its owner on this Mac, as one plain line with
 * one button: not installed (Install), out of date (Update), signed out
 * (Sign in), or failing to start (Install). Home, the first-run Home and a
 * space's agent list all show it the same way (`agent-problem-line.tsx`).
 * Each line names the CLI, its version when known, and the minimum Rig
 * needs when one is known.
 *
 * The version notices are soft: a copy older than the version Rig is
 * tested with (`belowMinimum`) or behind the latest release (`outdated`).
 * Only Settings › Agents asks for them (`soft`), and the app raises them
 * once per version as a toast (`agent-minimum-alert.ts`). Home and a
 * space's panel show only the hard problems: missing, signed out, failing
 * to start.
 */

export type AgentProblemKind = 'missing' | 'outdated' | 'belowMinimum' | 'signedOut' | 'error';

export type AgentProblem = {
  kind: AgentProblemKind;
  /** The CLI Rig runs: `claude`, `codex`. */
  cli: string;
  /** The version of the copy in use, when known. */
  version: string | null;
  /** The oldest version Rig works with, when known. */
  minimum: string | null;
  /** What the line says. */
  text: string;
  /** Its one button. */
  action: 'install' | 'update' | 'sign-in';
  /**
   * For Update: Rig updates the copy itself (`rig`), or says where it's
   * updated (`elsewhere`, with what to say: the ChatGPT app, Homebrew…).
   */
  update?: { how: 'rig' } | { how: 'elsewhere'; hint: string };
};

/**
 * The CLI versions Rig's bundled adapters are built against: the Claude Agent
 * SDK's `claudeCodeVersion`, and codex-acp's `@openai/codex` dependency.
 * Rig runs the copy on the Mac, so an older one gets a soft notice, never a
 * block. agent-problem.test.ts fails when an adapter bump moves them.
 */
export const AGENT_MINIMUM_VERSIONS: Readonly<Record<string, string>> = { claude: '2.1.287', codex: '0.159.1' };

const CLI_NAMES: Record<string, string> = { claude: 'claude', codex: 'codex' };

/** The app that bundles the copy in use (`ChatGPT` for `/Applications/ChatGPT.app/Contents/…`), or null. */
function bundlingApp(realpath: string): string | null {
  return /\/([^/]+)\.app\/Contents\//.exec(realpath)?.[1] ?? null;
}

export function agentProblem(input: {
  id: string;
  name: string;
  /** What the probe found; undefined while it hasn't answered. */
  payload: Pick<AgentInstallationStatus, 'status' | 'version' | 'installations' | 'used' | 'latestVersion'> | null | undefined;
  /** The owner has to sign in again here (`useAgentSignInNeeded`). */
  signInNeeded: boolean;
  /** Missing counts as a problem here: false where one missing agent of two isn't worth a line. */
  showMissing?: boolean;
  /** The soft version notices count here: Settings › Agents and the once-per-version alert. */
  soft?: boolean;
  minimum?: string | null;
}): AgentProblem | null {
  const { id, name, payload, signInNeeded, showMissing = true, soft = false } = input;
  const cli = CLI_NAMES[id] ?? id;
  const minimum = input.minimum === undefined ? (AGENT_MINIMUM_VERSIONS[id] ?? null) : input.minimum;
  const needs = minimum ? ` Rig is tested with ${minimum} or newer.` : '';
  if (!payload) return null;

  if (payload.status === 'missing') {
    if (!showMissing) return null;
    return { kind: 'missing', cli, version: null, minimum, text: `${name} isn't installed on this Mac. Rig runs the ${cli} CLI.${needs}`, action: 'install' };
  }

  const active = resolveActiveInstallation(payload.installations, payload.used);
  const version = active?.version ?? payload.version ?? null;
  const is = version ? ` The ${cli} CLI is ${version}.` : '';

  if (payload.status === 'error') {
    return {
      kind: 'error',
      cli,
      version,
      minimum,
      text: `${name} didn't start on this Mac.${is || ` Rig couldn't run the ${cli} CLI.`}${needs}`,
      action: 'install',
    };
  }

  const app = active ? bundlingApp(active.realpath) : null;
  const appHint = app ? `${app} carries its own ${cli} CLI. Update the ${app} app to update ${name}.` : null;
  const notice = agentUpdateNotice(name, payload);
  if (signInNeeded) {
    return { kind: 'signedOut', cli, version, minimum, text: `${name} isn't signed in on this Mac.${is}`, action: 'sign-in' };
  }
  if (!soft) return null;
  const belowMinimum = !!minimum && !!version && isOlderVersion(version, minimum);
  if (belowMinimum) {
    return {
      kind: 'belowMinimum',
      cli,
      version,
      minimum,
      text: `${name} is older than Rig is tested with.${is}${needs}`,
      action: 'update',
      update: appHint
        ? { how: 'elsewhere', hint: appHint }
        : notice.kind === 'elsewhere'
          ? { how: 'elsewhere', hint: notice.hint }
          : { how: 'rig' },
    };
  }

  if (notice.kind !== 'none') {
    return {
      kind: 'outdated',
      cli,
      version,
      minimum,
      text: `${name} is out of date.${is} ${notice.latest} is out.`,
      action: 'update',
      update: notice.kind === 'update' ? { how: 'rig' } : { how: 'elsewhere', hint: notice.hint },
    };
  }
  return null;
}
