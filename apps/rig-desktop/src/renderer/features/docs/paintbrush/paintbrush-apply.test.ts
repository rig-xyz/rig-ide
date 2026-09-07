import { describe, expect, it } from 'vitest';
import { canApplyProposal, resolveProposalApply } from './paintbrush-apply';

describe('resolveProposalApply', () => {
  it('splices the replacement over the anchored range', () => {
    const content = 'Intro line.\nThe quick brown fox jumps.\nOutro.';
    const result = resolveProposalApply(
      content,
      { exact: 'quick brown fox' },
      'lazy grey wolf'
    );

    expect(result).toEqual({
      ok: true,
      from: content.indexOf('quick brown fox'),
      to: content.indexOf('quick brown fox') + 'quick brown fox'.length,
      nextContent: 'Intro line.\nThe lazy grey wolf jumps.\nOutro.',
    });
  });

  it('refuses when there is no anchor at all', () => {
    expect(resolveProposalApply('anything', null, 'x')).toEqual({
      ok: false,
      reason: 'no-anchor',
    });
    expect(resolveProposalApply('anything', undefined, 'x')).toEqual({
      ok: false,
      reason: 'no-anchor',
    });
  });

  it('refuses an orphaned anchor rather than guessing a position', () => {
    const result = resolveProposalApply(
      'The document has changed entirely.',
      { exact: 'quick brown fox' },
      'lazy grey wolf'
    );
    expect(result).toEqual({ ok: false, reason: 'orphan' });
  });

  it('refuses a whitespace-only match — never fabricate a position', () => {
    // `reanchor` reports this as `anchored` with no `index` (only the
    // whitespace-normalized fallback matched) — resolveProposalApply must
    // treat that the same as an orphan, not apply at offset 0.
    const content = 'The quick   brown\nfox jumps.';
    const result = resolveProposalApply(content, { exact: 'quick brown fox' }, 'lazy grey wolf');
    expect(result).toEqual({ ok: false, reason: 'orphan' });
  });

  it('disambiguates a repeated quote using the recorded prefix/suffix', () => {
    const content = 'alpha TARGET omega\n\nbeta TARGET gamma\n';
    const second = content.lastIndexOf('TARGET');

    const result = resolveProposalApply(
      content,
      { exact: 'TARGET', prefix: 'beta ', suffix: ' gamma' },
      'HIT'
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.from).toBe(second);
      expect(result.nextContent).toBe('alpha TARGET omega\n\nbeta HIT gamma\n');
    }
  });
});

describe('canApplyProposal', () => {
  it('mirrors resolveProposalApply without needing a replacement string', () => {
    const content = 'The quick brown fox jumps.';
    expect(canApplyProposal(content, { exact: 'quick brown fox' })).toBe(true);
    expect(canApplyProposal(content, { exact: 'slow grey turtle' })).toBe(false);
    expect(canApplyProposal(content, null)).toBe(false);
  });
});
