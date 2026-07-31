import { describe, expect, it } from 'vitest';
import type {
  AgentCapabilities,
  AgentPayload,
  InstallOption,
} from '@shared/core/agents/agent-payload';
import {
  cliLoginMethod,
  hasInstalledAgent,
  onboardingAgents,
  preferredInstallOptions,
} from './agent-step-state';

const RECOMMENDED = new Set(['claude', 'codex', 'pi']);

function agent(
  id: string,
  name: string,
  status: 'available' | 'missing' = 'missing'
): AgentPayload {
  return { id, name, status } as AgentPayload;
}

function capabilities(auth: AgentCapabilities['auth']): AgentCapabilities {
  return { auth } as AgentCapabilities;
}

describe('onboardingAgents', () => {
  it('keeps only the recommended agents, sorted by name', () => {
    const agents = [
      agent('zed', 'Zed'),
      agent('codex', 'Codex'),
      agent('claude', 'Claude Code'),
      agent('pi', 'Pi'),
    ];
    expect(onboardingAgents(agents, RECOMMENDED).map((a) => a.id)).toEqual([
      'claude',
      'codex',
      'pi',
    ]);
  });

  it('falls back to every agent when none of the recommended ones exist', () => {
    const agents = [agent('zed', 'Zed'), agent('aider', 'Aider')];
    expect(onboardingAgents(agents, RECOMMENDED).map((a) => a.id)).toEqual(['aider', 'zed']);
  });

  it('handles the pre-fetch undefined list', () => {
    expect(onboardingAgents(undefined, RECOMMENDED)).toEqual([]);
  });
});

describe('hasInstalledAgent', () => {
  it('is true when any agent is available', () => {
    expect(hasInstalledAgent([agent('zed', 'Zed'), agent('claude', 'Claude', 'available')])).toBe(
      true
    );
  });

  it('is false for an empty or all-missing list', () => {
    expect(hasInstalledAgent([])).toBe(false);
    expect(hasInstalledAgent(undefined)).toBe(false);
    expect(hasInstalledAgent([agent('zed', 'Zed')])).toBe(false);
  });
});

describe('preferredInstallOptions', () => {
  const npm: InstallOption = { method: 'npm', command: 'npm i -g x', recommended: true };
  const brew: InstallOption = { method: 'homebrew', command: 'brew install x' };

  it('narrows to the recommended options when there are any', () => {
    expect(preferredInstallOptions([brew, npm])).toEqual([npm]);
  });

  it('keeps every option when none is flagged recommended', () => {
    expect(preferredInstallOptions([brew])).toEqual([brew]);
    expect(preferredInstallOptions([])).toEqual([]);
  });
});

describe('cliLoginMethod', () => {
  it('finds the cli-login method', () => {
    const method = {
      kind: 'cli-login' as const,
      id: 'login',
      name: 'Sign in',
      args: ['login'],
    };
    expect(
      cliLoginMethod(
        capabilities({
          kind: 'supported',
          methods: [
            { kind: 'api-key', id: 'key', name: 'API key', envVars: [{ name: 'K', label: 'K' }] },
            method,
          ],
        })
      )
    ).toEqual(method);
  });

  it('returns null when the agent only supports API keys', () => {
    expect(
      cliLoginMethod(
        capabilities({
          kind: 'supported',
          methods: [
            { kind: 'api-key', id: 'key', name: 'API key', envVars: [{ name: 'K', label: 'K' }] },
          ],
        })
      )
    ).toBeNull();
  });

  it('returns null when the agent has no auth at all', () => {
    expect(cliLoginMethod(capabilities({ kind: 'none' }))).toBeNull();
  });
});
