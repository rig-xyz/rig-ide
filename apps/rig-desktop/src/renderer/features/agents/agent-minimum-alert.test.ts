import { describe, expect, it } from 'vitest';
import { agentsToAlert } from './agent-minimum-alert';

const agent = (id: 'claude' | 'codex', version: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id === 'claude' ? 'Claude' : 'Codex',
  status: 'available' as const,
  version,
  latestVersion: version,
  used: { kind: 'auto' as const },
  installations: [
    {
      id: `/usr/local/bin/${id}`,
      realpath: `/usr/local/lib/node_modules/${id}/cli.js`,
      pathEntry: `/usr/local/bin/${id}`,
      isActive: true,
      manageable: true,
      provenance: { kind: 'npm' as const, confidence: 'confirmed' as const },
      status: 'available' as const,
      version,
      latestVersion: version,
      updateAvailable: false,
    },
  ],
  ...over,
});

describe('agentsToAlert', () => {
  it('alerts an agent older than Rig is tested with, once per version', () => {
    const old = agent('codex', '0.100.0');
    expect(agentsToAlert([old], {})).toMatchObject([
      { id: 'codex', version: '0.100.0', problem: { kind: 'belowMinimum', text: expect.stringContaining('older than Rig is tested with') } },
    ]);
    expect(agentsToAlert([old], { codex: '0.100.0' })).toEqual([]);
    // A different old version is new news.
    expect(agentsToAlert([agent('codex', '0.101.0')], { codex: '0.100.0' })).toHaveLength(1);
  });

  it('says nothing for a tested version, a missing agent, or one still being probed', () => {
    expect(agentsToAlert([agent('codex', '9.0.0'), agent('claude', '9.0.0')], {})).toEqual([]);
    expect(agentsToAlert([agent('codex', '0.100.0', { status: 'missing', version: null, installations: [] })], {})).toEqual([]);
    expect(agentsToAlert([agent('codex', '0.100.0', { status: 'error' })], {})).toEqual([]);
  });

  it('keeps each agent apart', () => {
    const both = [agent('claude', '1.0.0'), agent('codex', '0.100.0')];
    expect(agentsToAlert(both, { claude: '1.0.0' }).map((a) => a.id)).toEqual(['codex']);
  });
});
