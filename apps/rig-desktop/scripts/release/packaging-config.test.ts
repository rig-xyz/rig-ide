import { describe, expect, it } from 'vitest';
import canaryConfig from '../../electron-builder.canary.config';
import stableConfig from '../../electron-builder.config';

describe('Rig packaging configuration', () => {
  it.each([
    ['stable', stableConfig],
    ['canary', canaryConfig],
  ])('does not enable startup Keychain access in the %s build', (_channel, config) => {
    expect(config.electronFuses?.enableCookieEncryption).toBe(false);
  });
});

describe('Rig deep-link schemes', () => {
  it('gives canary its own scheme so it never claims the website rig:// links', () => {
    expect(stableConfig.protocols).toEqual([{ name: 'Rig', schemes: ['rig'] }]);
    expect(canaryConfig.protocols).toEqual([{ name: 'Rig Canary', schemes: ['rig-canary'] }]);
  });
});
