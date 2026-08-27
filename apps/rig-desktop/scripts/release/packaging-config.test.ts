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
