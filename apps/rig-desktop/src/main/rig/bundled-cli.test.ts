import { describe, expect, it } from 'vitest';
import { dedupeByRealPath, shapeLocalInstalls, type ProbedInstall } from './bundled-cli';

describe('dedupeByRealPath', () => {
  it('keeps every entry when none share a real target', () => {
    const paths = ['/usr/local/bin/rig', '/Users/dylan/.nvm/versions/node/v24.0.0/bin/rig'];
    expect(dedupeByRealPath(paths, (p) => p)).toEqual(paths);
  });

  it('drops a later entry whose real target matches an earlier one — nvm default alias vs. its own versioned dir', () => {
    const paths = [
      '/Users/dylan/.nvm/versions/node/v24.0.0/bin/rig',
      '/Users/dylan/.nvm/alias/default/bin/rig',
    ];
    const realTarget = '/Users/dylan/.nvm/versions/node/v24.0.0/bin/rig';
    expect(dedupeByRealPath(paths, () => realTarget)).toEqual([
      '/Users/dylan/.nvm/versions/node/v24.0.0/bin/rig',
    ]);
  });

  it('preserves original PATH order and the original (possibly symlinked) path, not the resolved target', () => {
    const paths = ['/opt/homebrew/bin/rig', '/usr/local/bin/rig'];
    expect(dedupeByRealPath(paths, (p) => p)).toEqual(paths);
  });

  it('a realpath that throws (broken symlink) falls back to the input path via the default resolver, never crashing the caller', () => {
    // No custom resolver passed — exercises the real `fs.realpathSync`
    // fallback against a path that cannot possibly exist.
    expect(dedupeByRealPath(['/nonexistent/path/rig'])).toEqual(['/nonexistent/path/rig']);
  });
});

describe('shapeLocalInstalls', () => {
  it('no candidates — everything null, no note', () => {
    expect(shapeLocalInstalls([])).toEqual({ local: null, localPath: null, multipleInstalls: null });
  });

  it('one candidate — reports it, no multi-install note (nothing to disagree with)', () => {
    const candidates: ProbedInstall[] = [{ path: '/usr/local/bin/rig', version: '0.2.0' }];
    expect(shapeLocalInstalls(candidates)).toEqual({
      local: '0.2.0',
      localPath: '/usr/local/bin/rig',
      multipleInstalls: null,
    });
  });

  it('several candidates agreeing on version — reports the first, no conflict note', () => {
    const candidates: ProbedInstall[] = [
      { path: '/usr/local/bin/rig', version: '0.10.1' },
      { path: '/Users/dylan/.nvm/versions/node/v20/bin/rig', version: '0.10.1' },
    ];
    expect(shapeLocalInstalls(candidates)).toEqual({
      local: '0.10.1',
      localPath: '/usr/local/bin/rig',
      multipleInstalls: null,
    });
  });

  it('candidates disagreeing on version — reports the FIRST as "using", and the count/path in the note (the live-finding bug: a stale /usr/local/bin install shadows a newer nvm one)', () => {
    const candidates: ProbedInstall[] = [
      { path: '/usr/local/bin/rig', version: '0.2.0' },
      { path: '/Users/dylan/.nvm/versions/node/v20/bin/rig', version: '0.5.9' },
      { path: '/Users/dylan/.nvm/versions/node/v24/bin/rig', version: '0.10.1' },
    ];
    expect(shapeLocalInstalls(candidates)).toEqual({
      local: '0.2.0',
      localPath: '/usr/local/bin/rig',
      multipleInstalls: { count: 3, usingPath: '/usr/local/bin/rig' },
    });
  });

  it('a failed probe (null version) never counts toward "distinct versions" on its own', () => {
    const candidates: ProbedInstall[] = [
      { path: '/usr/local/bin/rig', version: '0.10.1' },
      { path: '/opt/broken/rig', version: null },
    ];
    expect(shapeLocalInstalls(candidates)).toEqual({
      local: '0.10.1',
      localPath: '/usr/local/bin/rig',
      multipleInstalls: null,
    });
  });
});
