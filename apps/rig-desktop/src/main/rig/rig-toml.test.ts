import { describe, expect, it } from 'vitest';
import { setTomlRigName } from './rig-toml';

describe('setTomlRigName', () => {
  it('rewrites a simple name field', () => {
    const raw = ['[rig]', 'name = "old-name"', 'version = 1', ''].join('\n');
    expect(setTomlRigName(raw, 'new-name')).toBe(
      ['[rig]', 'name = "new-name"', 'version = 1', ''].join('\n')
    );
  });

  it('preserves every other line byte-identical, including comments', () => {
    const raw = [
      '# top-level comment',
      '',
      '[rig]',
      '# the display name',
      'name = "old-name" # inline comment',
      'description = "a real description"',
      '',
      '[sync]',
      'enabled = true',
      '',
    ].join('\n');
    const result = setTomlRigName(raw, 'renamed');
    expect(result).toBe(
      [
        '# top-level comment',
        '',
        '[rig]',
        '# the display name',
        'name = "renamed" # inline comment',
        'description = "a real description"',
        '',
        '[sync]',
        'enabled = true',
        '',
      ].join('\n')
    );
  });

  it('preserves the name line\'s own leading whitespace/indentation', () => {
    const raw = ['[rig]', '  name = "old-name"', ''].join('\n');
    expect(setTomlRigName(raw, 'new-name')).toBe(['[rig]', '  name = "new-name"', ''].join('\n'));
  });

  it('only rewrites name inside [rig], not a same-named key in another table', () => {
    const raw = ['[other]', 'name = "not this one"', '', '[rig]', 'name = "old-name"', ''].join('\n');
    expect(setTomlRigName(raw, 'new-name')).toBe(
      ['[other]', 'name = "not this one"', '', '[rig]', 'name = "new-name"', ''].join('\n')
    );
  });

  it('escapes double quotes and backslashes in the new name', () => {
    const raw = ['[rig]', 'name = "old"', ''].join('\n');
    expect(setTomlRigName(raw, 'a "quoted" name\\path')).toBe(
      ['[rig]', 'name = "a \\"quoted\\" name\\\\path"', ''].join('\n')
    );
  });

  it('returns null when there is no [rig] table at all', () => {
    const raw = ['[other]', 'name = "x"', ''].join('\n');
    expect(setTomlRigName(raw, 'new-name')).toBeNull();
  });

  it('returns null when [rig] exists but has no name field', () => {
    const raw = ['[rig]', 'description = "no name here"', ''].join('\n');
    expect(setTomlRigName(raw, 'new-name')).toBeNull();
  });
});
