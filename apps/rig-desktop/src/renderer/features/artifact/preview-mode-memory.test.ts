import { describe, expect, it } from 'vitest';
import { getPreviewMode, setPreviewMode } from './preview-mode-memory';

describe('preview mode memory', () => {
  it('defaults an unseen path to preview', () => {
    expect(getPreviewMode('/rig/unseen-a.md')).toBe('preview');
  });

  it('remembers a mode set for a path', () => {
    setPreviewMode('/rig/notes-a.md', 'edit');
    expect(getPreviewMode('/rig/notes-a.md')).toBe('edit');
  });

  it('keeps distinct paths independent', () => {
    setPreviewMode('/rig/one-a.md', 'edit');
    expect(getPreviewMode('/rig/two-a.md')).toBe('preview');
  });

  it('last write wins when toggled back and forth', () => {
    setPreviewMode('/rig/toggle-a.md', 'edit');
    setPreviewMode('/rig/toggle-a.md', 'preview');
    setPreviewMode('/rig/toggle-a.md', 'edit');
    expect(getPreviewMode('/rig/toggle-a.md')).toBe('edit');
  });
});
