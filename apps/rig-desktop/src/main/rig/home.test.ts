import { describe, expect, it } from 'vitest';
import { isInsideHome, mergeHomeIntoConfig, resolveHomeLandingDir, tildify } from './home';

describe('mergeHomeIntoConfig', () => {
  it('writes the home key while preserving every other key already in the config', () => {
    const existing = {
      hub_token: 'rpat_abc123',
      hub_user: { id: 'usr_1', name: 'Dylan' },
      relay_token: 'tok_xyz',
    };
    expect(mergeHomeIntoConfig(existing, '/Users/dylan/Rig')).toEqual({
      hub_token: 'rpat_abc123',
      hub_user: { id: 'usr_1', name: 'Dylan' },
      relay_token: 'tok_xyz',
      home: '/Users/dylan/Rig',
    });
  });

  it('overwrites a previously-set home without disturbing anything else', () => {
    const existing = { home: '/Users/dylan/OldRig', hub_token: 'rpat_abc123' };
    expect(mergeHomeIntoConfig(existing, '/Users/dylan/Rig')).toEqual({
      home: '/Users/dylan/Rig',
      hub_token: 'rpat_abc123',
    });
  });

  it('an empty config (no prior file, or a fresh install) — just the home key', () => {
    expect(mergeHomeIntoConfig({}, '/Users/dylan/Rig')).toEqual({ home: '/Users/dylan/Rig' });
  });

  it('does not mutate the config object passed in', () => {
    const existing = { hub_token: 'rpat_abc123' };
    mergeHomeIntoConfig(existing, '/Users/dylan/Rig');
    expect(existing).toEqual({ hub_token: 'rpat_abc123' });
  });
});

describe('tildify', () => {
  const home = process.env.HOME ?? '';

  it('shortens a path inside the home directory to ~/…', () => {
    if (!home) return;
    expect(tildify(`${home}/Rig`)).toBe('~/Rig');
  });

  it('home itself becomes bare ~', () => {
    if (!home) return;
    expect(tildify(home)).toBe('~');
  });

  it('a path outside home is left untouched', () => {
    expect(tildify('/opt/somewhere/Rig')).toBe('/opt/somewhere/Rig');
  });

  it('does not shorten a sibling directory that merely shares the home path as a prefix (e.g. ~-suffixed)', () => {
    if (!home) return;
    expect(tildify(`${home}-backup/Rig`)).toBe(`${home}-backup/Rig`);
  });
});

describe('isInsideHome', () => {
  it('a path directly under home is inside', () => {
    expect(isInsideHome('/Users/dylan/Rig/my-rig', '/Users/dylan/Rig')).toBe(true);
  });

  it('home itself counts as inside', () => {
    expect(isInsideHome('/Users/dylan/Rig', '/Users/dylan/Rig')).toBe(true);
  });

  it('a sibling folder that merely shares the home path as a string prefix is NOT inside', () => {
    expect(isInsideHome('/Users/dylan/Rig-backup/my-rig', '/Users/dylan/Rig')).toBe(false);
  });

  it('a genuinely unrelated path is outside', () => {
    expect(isInsideHome('/Users/dylan/Code/my-rig', '/Users/dylan/Rig')).toBe(false);
  });
});

describe('resolveHomeLandingDir', () => {
  it('no collision — plain `<baseDir>/<slug>`', () => {
    expect(resolveHomeLandingDir('/nonexistent-rig-home-test-xyz', 'my-rig')).toBe(
      '/nonexistent-rig-home-test-xyz/my-rig'
    );
  });
});
