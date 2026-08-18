import { describe, expect, it } from 'vitest';
import { deriveUnboundDetection } from '@shared/rig/workspace';

describe('deriveUnboundDetection', () => {
  it('classifies a rig.toml-bearing folder without a binding as an unsynced rig', () => {
    expect(
      deriveUnboundDetection({
        pickedPath: '/Users/dylan/knee-ability',
        pickedHasRigToml: true,
        pickedName: 'knee-ability',
      })
    ).toEqual({
      bound: false,
      unsynced: { path: '/Users/dylan/knee-ability', name: 'knee-ability' },
    });
  });

  it('keeps a plain folder the unchanged not-a-rig outcome', () => {
    expect(
      deriveUnboundDetection({
        pickedPath: '/Users/dylan/random',
        pickedHasRigToml: false,
        pickedName: null,
      })
    ).toEqual({ bound: false, unsynced: null });
  });

  it('tolerates a manifest without a readable name', () => {
    expect(
      deriveUnboundDetection({ pickedPath: '/x', pickedHasRigToml: true, pickedName: null })
    ).toEqual({ bound: false, unsynced: { path: '/x', name: null } });
  });
});
