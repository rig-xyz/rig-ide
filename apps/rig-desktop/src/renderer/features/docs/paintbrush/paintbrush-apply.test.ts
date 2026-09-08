import { describe, expect, it } from 'vitest';
import {
  canApplyProposal,
  recordProposalApply,
  resolveProposalApply,
  resolveProposalRevert,
} from './paintbrush-apply';

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
      original: 'quick brown fox',
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

describe('resolveProposalApply — deletions', () => {
  it('removes the whole line when a deletion would leave only a marker behind', () => {
    const content = '# Title\n\nBody stays.\n';
    const result = resolveProposalApply(content, { exact: 'Title' }, '');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.original).toBe('# Title\n');
      expect(result.nextContent).toBe('\nBody stays.\n');
    }
  });

  it('keeps an in-sentence deletion exactly as narrow as the passage', () => {
    const content = 'The quick brown fox jumps.';
    const result = resolveProposalApply(content, { exact: 'quick ' }, '');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextContent).toBe('The brown fox jumps.');
  });

  it('removes a bullet line entirely, at the end of the document too', () => {
    const content = '- keep\n- drop me';
    const result = resolveProposalApply(content, { exact: 'drop me' }, '');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextContent).toBe('- keep');
  });
});

describe('recordProposalApply / resolveProposalRevert', () => {
  it('round-trips an applied replacement back to the original', () => {
    const content = 'Intro.\nThe quick brown fox jumps.\nOutro.';
    const applied = resolveProposalApply(content, { exact: 'quick brown fox' }, 'lazy grey wolf');
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const record = recordProposalApply(applied.nextContent, applied.from, 'lazy grey wolf', applied.original);
    const reverted = resolveProposalRevert(applied.nextContent, record);
    expect(reverted).toEqual({ ok: true, nextContent: content });
  });

  it('round-trips a whole-line deletion', () => {
    const content = '# Title\n\nBody.\n';
    const applied = resolveProposalApply(content, { exact: 'Title' }, '');
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const record = recordProposalApply(applied.nextContent, applied.from, '', applied.original);
    expect(resolveProposalRevert(applied.nextContent, record)).toEqual({ ok: true, nextContent: content });
  });

  it('refuses to revert when the applied span is no longer found exactly once', () => {
    const record = { original: 'old', replacement: 'new', prefix: 'a ', suffix: ' b' };
    expect(resolveProposalRevert('a new b and a new b', record)).toEqual({ ok: false });
    expect(resolveProposalRevert('completely different', record)).toEqual({ ok: false });
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
