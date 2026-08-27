import { describe, expect, it } from 'vitest';
import { deriveNativeCloseTarget } from './native-close-target';

const base = {
  settingsOpen: false,
  hasRig: true,
  layout: 'split' as const,
  focusedPane: 'chat' as const,
  hasArtifactTab: true,
  hasChatTab: true,
};

describe('deriveNativeCloseTarget', () => {
  it('closes Settings before any underlying tab', () => {
    expect(deriveNativeCloseTarget({ ...base, settingsOpen: true })).toBe('settings');
  });

  it('closes the focused tab system in split layout', () => {
    expect(deriveNativeCloseTarget(base)).toBe('chat');
    expect(deriveNativeCloseTarget({ ...base, focusedPane: 'artifact' })).toBe('artifact');
  });

  it('uses the only visible tab system in single-pane layouts', () => {
    expect(deriveNativeCloseTarget({ ...base, layout: 'chat' })).toBe('chat');
    expect(deriveNativeCloseTarget({ ...base, layout: 'files' })).toBe('artifact');
  });

  it('falls back to the remaining closeable tab and disables at home', () => {
    expect(deriveNativeCloseTarget({ ...base, focusedPane: 'chat', hasChatTab: false })).toBe(
      'artifact'
    );
    expect(deriveNativeCloseTarget({ ...base, hasRig: false })).toBeNull();
  });
});
