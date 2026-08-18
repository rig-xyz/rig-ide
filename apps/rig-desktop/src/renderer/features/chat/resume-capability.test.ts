import { describe, expect, it } from 'vitest';
import { canResumeProvider, canResumeSession } from './resume-capability';

describe('canResumeProvider', () => {
  it('is true for claude and codex — verified bundled adapters', () => {
    expect(canResumeProvider('claude')).toBe(true);
    expect(canResumeProvider('codex')).toBe(true);
  });

  it('is false for every other provider, however plausible', () => {
    expect(canResumeProvider('cursor')).toBe(false);
    expect(canResumeProvider('droid')).toBe(false);
    expect(canResumeProvider('qwen')).toBe(false);
    expect(canResumeProvider('unknown-provider')).toBe(false);
  });
});

describe('canResumeSession', () => {
  it('requires both a resumable provider and a known acpSessionId', () => {
    expect(canResumeSession('claude', 'acp-123')).toBe(true);
  });

  it('is false when the provider is resumable but no acpSessionId was ever captured', () => {
    expect(canResumeSession('claude', null)).toBe(false);
    expect(canResumeSession('claude', '')).toBe(false);
  });

  it('is false for a non-resumable provider even with an acpSessionId present', () => {
    expect(canResumeSession('cursor', 'acp-123')).toBe(false);
  });
});
