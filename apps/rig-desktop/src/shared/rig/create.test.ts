import { describe, expect, it } from 'vitest';
import { folderMatchesName, rigFolderSlug } from './create';

describe('rigFolderSlug — the folder `rig attach`, `rig join` and `rig move` use', () => {
  it("follows the CLI's own rule", () => {
    expect(rigFolderSlug('rig-feedback')).toBe('rig-feedback');
    expect(rigFolderSlug('  Mktg Emails ')).toBe('mktg-emails');
    expect(rigFolderSlug('growth_v1.2')).toBe('growth-v1-2');
    expect(rigFolderSlug('x'.repeat(80))).toHaveLength(60);
    expect(rigFolderSlug('###')).toBe('shared-rig');
  });
});

describe('folderMatchesName', () => {
  it('is its slug, or its slug with a clash suffix', () => {
    expect(folderMatchesName('rig-feedback', 'rig-feedback')).toBe(true);
    expect(folderMatchesName('rig-feedback-2', 'rig-feedback')).toBe(true);
    expect(folderMatchesName('clear-harbor', 'rig-feedback')).toBe(false);
    expect(folderMatchesName('rig-feedback-old', 'rig-feedback')).toBe(false);
  });
});
