import { describe, expect, it } from 'vitest';
import { classifyProviderAnswer } from './comment-agent-answer-classify';

describe('classifyProviderAnswer', () => {
  it('passes an ordinary answer through untouched', () => {
    const answer = 'Tightened the wording — see the proposed replacement below.';
    expect(classifyProviderAnswer(answer)).toEqual({
      kind: 'ok',
      text: answer,
      strippedWarnings: [],
    });
  });

  it('strips leading Warning: lines off an otherwise-valid answer', () => {
    const answer = [
      'Warning: npm config "foo" is deprecated',
      'Warning: falling back to default settings',
      '',
      'Done — tightened the passage.',
    ].join('\n');
    const result = classifyProviderAnswer(answer);
    expect(result).toEqual({
      kind: 'ok',
      text: 'Done — tightened the passage.',
      strippedWarnings: [
        'Warning: npm config "foo" is deprecated',
        'Warning: falling back to default settings',
      ],
    });
  });

  it('leaves a normal answer that merely starts with a blank line alone', () => {
    const answer = '\nStill a real answer.';
    expect(classifyProviderAnswer(answer)).toEqual({
      kind: 'ok',
      text: answer,
      strippedWarnings: [],
    });
  });

  it('classifies a model-unsupported JSON error payload, naming the offending model', () => {
    const answer = JSON.stringify({
      type: 'error',
      error: {
        message: 'The model `gpt-6-astra` requires a newer version of Codex.',
      },
    });
    const result = classifyProviderAnswer(answer);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') throw new Error('unreachable');
    expect(result.reason).toBe('model-unsupported');
    expect(result.message).toContain('gpt-6-astra');
    expect(result.message).toContain('0.142.4');
    expect(result.message).toContain('~/.codex/config.toml');
  });

  it('classifies the real-world shape: warnings, then a raw JSON error, as one failure', () => {
    const answer = [
      'Warning: codex-acp running in compatibility mode',
      '',
      JSON.stringify({
        type: 'error',
        error: { message: 'Model `gpt-6-astra` requires a newer version of Codex to use.' },
      }),
    ].join('\n');
    const result = classifyProviderAnswer(answer);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') throw new Error('unreachable');
    expect(result.reason).toBe('model-unsupported');
    expect(result.strippedWarnings).toEqual(['Warning: codex-acp running in compatibility mode']);
    expect(result.message).toContain('gpt-6-astra');
  });

  it('classifies a generic JSON error payload (no model-unsupported phrase) as error-payload', () => {
    const answer = JSON.stringify({ type: 'error', error: { message: 'connection reset' } });
    const result = classifyProviderAnswer(answer);
    expect(result).toEqual({
      kind: 'failure',
      reason: 'error-payload',
      message: 'The agent reported an error instead of answering: connection reset',
      strippedWarnings: [],
    });
  });

  it('classifies an answer that is only Warning: lines as warnings-only', () => {
    const answer = 'Warning: one thing\nWarning: another thing\n';
    const result = classifyProviderAnswer(answer);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') throw new Error('unreachable');
    expect(result.reason).toBe('warnings-only');
    expect(result.strippedWarnings).toEqual(['Warning: one thing', 'Warning: another thing']);
  });

  it('does not misclassify a normal answer that happens to quote JSON-looking text with no error shape', () => {
    const answer = 'Your config has `{"theme": "dark", "message": "hello"}` in it — that looks fine.';
    expect(classifyProviderAnswer(answer)).toEqual({
      kind: 'ok',
      text: answer,
      strippedWarnings: [],
    });
  });

  it('falls back to generic phrasing when no model name can be extracted', () => {
    const answer = 'A model requires a newer version of Codex to run.';
    const result = classifyProviderAnswer(answer);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') throw new Error('unreachable');
    expect(result.reason).toBe('model-unsupported');
    expect(result.message).toContain('selects a model that');
  });
});

describe('classifyProviderAnswer — the real Codex 0.142.4 / gpt-6-astra transcript', () => {
  // Verbatim shape of what the bundled codex-acp posted into a thread on
  // 2026-09-07: two warning paragraphs, then the raw 400 payload as text.
  const real = [
    'Warning: Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
    '',
    'Warning: Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.',
    '',
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}',
  ].join('\n');

  it('classifies it as model-unsupported and names the model', () => {
    const result = classifyProviderAnswer(real);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason).toBe('model-unsupported');
    expect(result.message).toContain('gpt-6-astra');
    expect(result.message).toContain('0.142.4');
    expect(result.strippedWarnings).toHaveLength(2);
  });
});
