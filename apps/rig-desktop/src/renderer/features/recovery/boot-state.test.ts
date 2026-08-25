import { describe, expect, it } from 'vitest';
import { deriveRendererBootState } from './boot-state';

describe('deriveRendererBootState', () => {
  it('stays initializing while either boot dependency is pending', () => {
    expect(deriveRendererBootState({ settings: 'pending', auth: 'ready' })).toBe('initializing');
    expect(deriveRendererBootState({ settings: 'ready', auth: 'pending' })).toBe('initializing');
  });

  it('fails when settings cannot load', () => {
    expect(deriveRendererBootState({ settings: 'failed', auth: 'ready' })).toBe('failed');
  });

  it('degrades when optional auth status fails after settings are ready', () => {
    expect(deriveRendererBootState({ settings: 'ready', auth: 'failed' })).toBe('degraded');
  });

  it('returns to ready after retry or continue override', () => {
    expect(deriveRendererBootState({ settings: 'ready', auth: 'ready' })).toBe('ready');
    expect(deriveRendererBootState({ settings: 'failed', auth: 'failed', override: true })).toBe(
      'ready'
    );
  });

  it('fails when boot dependencies never settle before the deadline', () => {
    expect(deriveRendererBootState({ settings: 'pending', auth: 'pending', timedOut: true })).toBe(
      'failed'
    );
  });
});
