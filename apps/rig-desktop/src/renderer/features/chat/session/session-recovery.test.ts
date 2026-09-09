import { describe, expect, it } from 'vitest';
import { extractErrorMessage, isSessionFailureError } from './session-recovery';

describe('isSessionFailureError', () => {
  it('is true for the three RPCs a dead session forwards into the adapter', () => {
    expect(isSessionFailureError({ type: 'prompt_failed' })).toBe(true);
    expect(isSessionFailureError({ type: 'set_mode_failed' })).toBe(true);
    expect(isSessionFailureError({ type: 'set_config_failed' })).toBe(true);
  });

  it('is false for errors that do not indicate a dead adapter session', () => {
    expect(isSessionFailureError({ type: 'conversation_not_found' })).toBe(false);
    expect(isSessionFailureError({ type: 'invalid_state' })).toBe(false);
    expect(isSessionFailureError({ type: 'cancel_failed' })).toBe(false);
  });

  it('is false for non-error-shaped values', () => {
    expect(isSessionFailureError(null)).toBe(false);
    expect(isSessionFailureError(undefined)).toBe(false);
    expect(isSessionFailureError('prompt_failed')).toBe(false);
    expect(isSessionFailureError(new Error('boom'))).toBe(false);
  });
});

describe('extractErrorMessage', () => {
  it('reads the message off a thrown Error', () => {
    expect(extractErrorMessage(new Error('network down'))).toBe('network down');
  });

  it('reads the message off a BaseError-shaped runtime error', () => {
    expect(extractErrorMessage({ type: 'prompt_failed', message: 'from message' })).toBe(
      'from message'
    );
  });

  it('falls back to cause.message when message is absent', () => {
    expect(
      extractErrorMessage({
        type: 'prompt_failed',
        cause: { name: 'Error', message: 'The Claude Agent session has ended.' },
      })
    ).toBe('The Claude Agent session has ended.');
  });

  it('prefers message over cause.message when both are present', () => {
    expect(
      extractErrorMessage({
        type: 'prompt_failed',
        message: 'top-level',
        cause: { name: 'Error', message: 'nested' },
      })
    ).toBe('top-level');
  });

  it('returns undefined when there is nothing to extract', () => {
    expect(extractErrorMessage({ type: 'prompt_failed' })).toBeUndefined();
    expect(extractErrorMessage(null)).toBeUndefined();
    expect(extractErrorMessage('a bare string')).toBeUndefined();
  });

  it('keeps only the first line', () => {
    expect(extractErrorMessage(new Error('line one\nline two'))).toBe('line one');
  });

  it('truncates a long message with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const result = extractErrorMessage(new Error(long), 20);
    expect(result).toHaveLength(20);
    expect(result?.endsWith('…')).toBe(true);
  });
});
