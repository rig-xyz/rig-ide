import { describe, expect, it } from 'vitest';
import { deriveCliVersionRow } from './cli-versions';

describe('deriveCliVersionRow', () => {
  it('collapses matching bundled and local into one quiet value', () => {
    expect(deriveCliVersionRow({ bundled: '0.10.2', local: '0.10.2' })).toEqual({
      kind: 'equal',
      label: '0.10.2 · bundled = local',
      tone: 'muted',
      inUse: 'bundled',
      localPath: null,
      multipleInstallsNote: null,
    });
  });

  it('flags a version conflict with both values explicit and the warning tone', () => {
    expect(deriveCliVersionRow({ bundled: '0.10.2', local: '0.9.8' })).toEqual({
      kind: 'conflict',
      label: 'bundled 0.10.2 · local 0.9.8',
      tone: 'warning',
      inUse: 'bundled',
      localPath: null,
      multipleInstallsNote: null,
    });
  });

  it('marks the bundled install as in use whenever it exists — shim-first resolution', () => {
    expect(deriveCliVersionRow({ bundled: '0.10.2', local: '0.9.8' }).inUse).toBe('bundled');
    expect(deriveCliVersionRow({ bundled: '0.10.2', local: null }).inUse).toBe('bundled');
  });

  it('shows a lone source with its annotation (dev: local only; no global install: bundled only)', () => {
    expect(deriveCliVersionRow({ bundled: null, local: '0.10.2' })).toEqual({
      kind: 'single',
      label: '0.10.2 · local',
      tone: 'muted',
      inUse: 'local',
      localPath: null,
      multipleInstallsNote: null,
    });
    expect(deriveCliVersionRow({ bundled: '0.10.2', local: null })).toEqual({
      kind: 'single',
      label: '0.10.2 · bundled',
      tone: 'muted',
      inUse: 'bundled',
      localPath: null,
      multipleInstallsNote: null,
    });
  });

  it('reports neither install honestly', () => {
    expect(deriveCliVersionRow({ bundled: null, local: null })).toEqual({
      kind: 'missing',
      label: 'not found',
      tone: 'muted',
      inUse: null,
      localPath: null,
      multipleInstallsNote: null,
    });
  });

  it('carries the local install\'s own resolved path — self-diagnosing a name collision or stale install', () => {
    expect(
      deriveCliVersionRow({ bundled: null, local: '0.10.1', localPath: '/usr/local/bin/rig' }).localPath
    ).toBe('/usr/local/bin/rig');
    expect(
      deriveCliVersionRow({
        bundled: '0.10.2',
        local: '0.9.8',
        localPath: '/Users/dylan/.nvm/versions/node/v20/bin/rig',
      }).localPath
    ).toBe('/Users/dylan/.nvm/versions/node/v20/bin/rig');
  });

  it('never shows a path for a bundled-only row — there is no local install to point at', () => {
    expect(
      deriveCliVersionRow({ bundled: '0.10.2', local: null, localPath: '/should/be/ignored' }).localPath
    ).toBeNull();
  });

  it('surfaces the multi-install note verbatim as one muted line', () => {
    const row = deriveCliVersionRow({
      bundled: null,
      local: '0.2.0',
      localPath: '/usr/local/bin/rig',
      multipleInstalls: { count: 3, usingPath: '/usr/local/bin/rig' },
    });
    expect(row.multipleInstallsNote).toBe('3 installs found on PATH; using /usr/local/bin/rig');
  });

  it('no multi-install note when the source omits it (a single install, or none)', () => {
    expect(deriveCliVersionRow({ bundled: '0.10.2', local: '0.10.2' }).multipleInstallsNote).toBeNull();
  });
});
