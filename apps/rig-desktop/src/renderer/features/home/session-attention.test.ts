import { describe, expect, it } from 'vitest';
import { deriveRowAttentionStatus, deriveSessionAttentionStatus } from './session-attention';

describe('deriveSessionAttentionStatus', () => {
  it('isWorking always wins, regardless of output/seen times', () => {
    expect(deriveSessionAttentionStatus({ isWorking: true, lastOutputAt: null, lastSeenAt: 100 })).toBe(
      'working'
    );
  });

  it('output landed, never seen — unread', () => {
    expect(deriveSessionAttentionStatus({ isWorking: false, lastOutputAt: 100, lastSeenAt: null })).toBe(
      'unread'
    );
  });

  it('output landed after the last time it was seen — unread', () => {
    expect(deriveSessionAttentionStatus({ isWorking: false, lastOutputAt: 200, lastSeenAt: 100 })).toBe(
      'unread'
    );
  });

  it('seen at or after the last output — idle', () => {
    expect(deriveSessionAttentionStatus({ isWorking: false, lastOutputAt: 100, lastSeenAt: 100 })).toBe(
      'idle'
    );
    expect(deriveSessionAttentionStatus({ isWorking: false, lastOutputAt: 100, lastSeenAt: 200 })).toBe(
      'idle'
    );
  });

  it('nothing recorded at all — idle', () => {
    expect(deriveSessionAttentionStatus({ isWorking: false, lastOutputAt: null, lastSeenAt: null })).toBe(
      'idle'
    );
  });
});

describe('deriveRowAttentionStatus', () => {
  it('no sessions — idle', () => {
    expect(deriveRowAttentionStatus([])).toBe('idle');
  });

  it('all idle — idle', () => {
    expect(deriveRowAttentionStatus(['idle', 'idle'])).toBe('idle');
  });

  it('picks the loudest status among sessions', () => {
    expect(deriveRowAttentionStatus(['idle', 'unread', 'idle'])).toBe('unread');
    expect(deriveRowAttentionStatus(['idle', 'unread', 'working'])).toBe('working');
    expect(deriveRowAttentionStatus(['working', 'idle'])).toBe('working');
  });
});
