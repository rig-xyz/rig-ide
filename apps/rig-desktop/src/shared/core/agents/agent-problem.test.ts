import { describe, expect, it } from 'vitest';
import type { AgentInstallationStatus, Installation } from './agent-payload';
import { agentProblem } from './agent-problem';

function install(overrides: Partial<Installation> = {}): Installation {
  return {
    id: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    realpath: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    pathEntry: '/usr/local/bin/codex',
    isActive: true,
    manageable: true,
    provenance: { kind: 'npm', confidence: 'confirmed' },
    status: 'available',
    version: '0.160.1',
    latestVersion: '0.160.1',
    updateAvailable: false,
    ...overrides,
  };
}

type Payload = Pick<AgentInstallationStatus, 'status' | 'version' | 'installations' | 'used' | 'latestVersion'>;
function payload(overrides: Partial<Payload> = {}, installation: Partial<Installation> = {}): Payload {
  const installations = [install(installation)];
  return { status: 'available', version: installations[0]!.version, installations, used: { kind: 'auto' }, latestVersion: '0.160.1', ...overrides };
}

const CHATGPT = {
  id: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  realpath: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  pathEntry: null,
  manageable: false,
  provenance: { kind: 'unknown', confidence: 'inferred' },
} as const;

const codex = (p: Payload | null | undefined, over: { signInNeeded?: boolean; showMissing?: boolean; minimum?: string | null } = {}) =>
  agentProblem({ id: 'codex', name: 'Codex', payload: p, signInNeeded: over.signInNeeded ?? false, showMissing: over.showMissing, minimum: over.minimum ?? null });

describe('agentProblem', () => {
  it('says nothing for a current, signed in agent, or before the probe answers', () => {
    expect(codex(payload())).toBeNull();
    expect(codex(undefined)).toBeNull();
  });

  it('missing: names the CLI and the minimum, with Install', () => {
    expect(codex(payload({ status: 'missing', version: null, installations: [] }), { minimum: '0.150.0' })).toEqual({
      kind: 'missing',
      cli: 'codex',
      version: null,
      minimum: '0.150.0',
      text: "Codex isn't installed on this Mac. Rig runs the codex CLI. Rig needs 0.150.0 or later.",
      action: 'install',
    });
    expect(codex(payload({ status: 'missing', version: null, installations: [] }))?.text).toBe("Codex isn't installed on this Mac. Rig runs the codex CLI.");
  });

  it('missing is left out where it is not worth a line', () => {
    expect(codex(payload({ status: 'missing', version: null, installations: [] }), { showMissing: false })).toBeNull();
  });

  it('errored: names the CLI and its version, with Install', () => {
    expect(codex(payload({ status: 'error' }))).toMatchObject({
      kind: 'error',
      text: "Codex didn't start on this Mac. The codex CLI is 0.160.1.",
      action: 'install',
    });
    expect(codex(payload({ status: 'error', version: null }, { version: null }))?.text).toBe(
      "Codex didn't start on this Mac. Rig couldn't run the codex CLI."
    );
  });

  it('signed out: names the CLI and its version, with Sign in', () => {
    expect(codex(payload(), { signInNeeded: true })).toEqual({
      kind: 'signedOut',
      cli: 'codex',
      version: '0.160.1',
      minimum: null,
      text: "Codex isn't signed in on this Mac. The codex CLI is 0.160.1.",
      action: 'sign-in',
    });
  });

  it('outdated behind the latest release: Update that Rig runs', () => {
    expect(codex(payload({}, { version: '0.147.0' }))).toMatchObject({
      kind: 'outdated',
      version: '0.147.0',
      text: 'Codex is out of date. The codex CLI is 0.147.0. 0.160.1 is out.',
      action: 'update',
      update: { how: 'rig' },
    });
  });

  it('outdated below the minimum: says the minimum, and comes before a sign in', () => {
    expect(codex(payload({}, { version: '0.147.0' }), { minimum: '0.150.0', signInNeeded: true })).toMatchObject({
      kind: 'outdated',
      minimum: '0.150.0',
      text: 'Codex is out of date. The codex CLI is 0.147.0. Rig needs 0.150.0 or later.',
      update: { how: 'rig' },
    });
  });

  it('a signed out agent that is merely behind the latest asks to sign in first', () => {
    expect(codex(payload({}, { version: '0.147.0' }), { signInNeeded: true })?.kind).toBe('signedOut');
  });

  it("Codex inside the ChatGPT app: Update says to update the ChatGPT app", () => {
    const p = payload({}, { ...CHATGPT, version: '0.147.0' });
    expect(codex(p, { minimum: '0.150.0' })).toMatchObject({
      kind: 'outdated',
      update: { how: 'elsewhere', hint: 'ChatGPT carries its own codex CLI. Update the ChatGPT app to update Codex.' },
    });
    // Only behind npm's latest: the app updates it on its own, so no line.
    expect(codex(p)).toBeNull();
  });

  it('a Homebrew copy: Update says how to update it with Homebrew', () => {
    const p = payload({}, { version: '0.147.0', provenance: { kind: 'homebrew', confidence: 'confirmed', managerRef: 'codex' } });
    expect(codex(p)?.update).toEqual({ how: 'elsewhere', hint: 'Homebrew installed this copy. Update it with brew upgrade codex.' });
  });

  it('names Claude Code by its CLI', () => {
    const result = agentProblem({ id: 'claude', name: 'Claude', payload: payload({ status: 'missing', version: null, installations: [] }), signInNeeded: false });
    expect(result?.text).toBe("Claude isn't installed on this Mac. Rig runs the claude CLI.");
  });
});
