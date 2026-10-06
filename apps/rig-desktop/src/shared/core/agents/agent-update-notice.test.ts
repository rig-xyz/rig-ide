import { describe, expect, it } from 'vitest';
import type { Installation } from './agent-payload';
import { agentUpdateNotice, isOlderVersion } from './agent-update-notice';

describe('isOlderVersion', () => {
  it('compares segment by segment, numerically', () => {
    expect(isOlderVersion('0.147.0', '0.160.1')).toBe(true);
    expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true);
    expect(isOlderVersion('2.1.149', '2.1.150')).toBe(true);
  });

  it('is false for the same or a newer version', () => {
    expect(isOlderVersion('0.160.1', '0.160.1')).toBe(false);
    expect(isOlderVersion('1.2', '1.2.0')).toBe(false);
    expect(isOlderVersion('0.161.0', '0.160.1')).toBe(false);
  });

  it('reads the version out of prefixes and ignores prerelease suffixes', () => {
    expect(isOlderVersion('v0.147.0', '0.160.1')).toBe(true);
    expect(isOlderVersion('codex-cli 0.147.0', '0.160.1')).toBe(true);
    expect(isOlderVersion('0.161.0-alpha.2', '0.160.1')).toBe(false);
  });

  it('never calls an unreadable version older', () => {
    expect(isOlderVersion('unknown', '0.160.1')).toBe(false);
    expect(isOlderVersion('0.147.0', '')).toBe(false);
  });
});

function install(overrides: Partial<Installation>): Installation {
  return {
    id: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    realpath: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    pathEntry: '/usr/local/bin/codex',
    isActive: true,
    manageable: true,
    provenance: { kind: 'npm', confidence: 'confirmed' },
    status: 'available',
    version: '0.147.0',
    latestVersion: '0.160.1',
    updateAvailable: true,
    ...overrides,
  };
}

function notice(installations: Installation[]) {
  return agentUpdateNotice('Codex', { installations, used: { kind: 'auto' }, latestVersion: '0.160.1' });
}

describe('agentUpdateNotice', () => {
  it('offers the Update button for an npm install Rig can manage', () => {
    expect(notice([install({})])).toEqual({ kind: 'update', installed: '0.147.0', latest: '0.160.1' });
  });

  it('shows nothing when the copy in use is current', () => {
    expect(notice([install({ version: '0.160.1' })])).toEqual({ kind: 'none' });
  });

  it('shows nothing while the latest version is unknown', () => {
    expect(
      agentUpdateNotice('Codex', {
        installations: [install({ latestVersion: null })],
        used: { kind: 'auto' },
        latestVersion: null,
      })
    ).toEqual({ kind: 'none' });
  });

  it("points at the ChatGPT app when its bundled codex is the one in use", () => {
    const bundled = install({
      id: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      realpath: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      pathEntry: null,
      manageable: false,
      provenance: { kind: 'unknown', confidence: 'inferred' },
    });
    expect(notice([install({ isActive: false }), { ...bundled, isActive: true }])).toEqual({
      kind: 'elsewhere',
      installed: '0.147.0',
      latest: '0.160.1',
      hint: 'Update the ChatGPT app to get a newer Codex.',
    });
  });

  it('points at Homebrew for a Homebrew install, even one Rig could upgrade', () => {
    const brew = install({
      realpath: '/opt/homebrew/Caskroom/claude-code/2.1.149/claude',
      provenance: { kind: 'homebrew', confidence: 'confirmed', managerRef: 'claude-code' },
      version: '2.1.149',
      latestVersion: '2.1.160',
    });
    expect(agentUpdateNotice('Claude', { installations: [brew], used: { kind: 'auto' }, latestVersion: '2.1.160' })).toEqual({
      kind: 'elsewhere',
      installed: '2.1.149',
      latest: '2.1.160',
      hint: 'Homebrew installed this copy. Update it with brew upgrade claude-code.',
    });
  });

  it('says to update it where it came from when Rig cannot manage the copy', () => {
    const result = notice([install({ manageable: false, provenance: { kind: 'unknown', confidence: 'inferred' } })]);
    expect(result).toMatchObject({ kind: 'elsewhere', hint: "Rig didn't install this copy of Codex. Update it the way you installed it." });
  });

  it('follows a pinned selection rather than the PATH winner', () => {
    const pinned = install({ id: '/pinned/codex', realpath: '/pinned/codex', isActive: false, version: '0.160.1' });
    expect(
      agentUpdateNotice('Codex', {
        installations: [install({}), pinned],
        used: { kind: 'pinned', realpath: '/pinned/codex' },
        latestVersion: '0.160.1',
      })
    ).toEqual({ kind: 'none' });
  });
});
