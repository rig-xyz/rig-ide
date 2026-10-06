import { describe, expect, it } from 'vitest';
import {
  basenamePaths,
  MAX_ERROR_MESSAGE_CHARS,
  scrubCode,
  scrubErrorMessage,
  scrubModelId,
  scrubVersion,
  topStackFrame,
} from './telemetry-scrub';

describe('scrubErrorMessage', () => {
  it('cuts every path to its file name, so no user or folder names leave', () => {
    const scrubbed = scrubErrorMessage(
      "ENOENT: no such file or directory, open '/Users/dylan/Rig/Acme Plans/notes.md'"
    );
    expect(scrubbed).toContain('notes.md');
    expect(scrubbed).not.toMatch(/dylan|Users|Acme|Rig\//);
  });

  it('handles Windows, file:// and relative paths too', () => {
    expect(basenamePaths('at C:\\Users\\ana\\app\\main.js:3')).toBe('at main.js:3');
    expect(basenamePaths('loading file:///Users/ana/x/y/index.html failed')).toBe(
      'loading index.html failed'
    );
    expect(basenamePaths('src/main/rig/files.ts broke')).toBe('files.ts broke');
  });

  it('removes relay tokens, bearer strings, API keys and emails', () => {
    const scrubbed = scrubErrorMessage(
      'relay said 401 for rpat_AbCdEfGhIjKlMnOpQrStUvWx (Bearer abcdef123456) key sk-ant-abcdefghijklmnopqrstuv for dylan@example.com'
    );
    expect(scrubbed).not.toMatch(/rpat_|abcdef123456|sk-ant-|dylan@example\.com/);
    expect(scrubbed).toContain('[REDACTED_RIG_TOKEN]');
    expect(scrubbed).toContain('[REDACTED_EMAIL]');
  });

  it('a secret inside a URL path is cut to its last part, then redacted', () => {
    expect(
      scrubErrorMessage(
        'POST https://tap-relay.fly.dev/v1/invites/tap_inv_AbCdEfGhIjKlMnOpQrSt failed'
      )
    ).toBe('POST [REDACTED_RIG_TOKEN] failed');
  });

  it(`is at most ${MAX_ERROR_MESSAGE_CHARS} characters, whitespace collapsed`, () => {
    const scrubbed = scrubErrorMessage(`boom\n\n   ${'x'.repeat(1_000)}`);
    expect(scrubbed.length).toBe(MAX_ERROR_MESSAGE_CHARS);
    expect(scrubbed.startsWith('boom x')).toBe(true);
    expect(scrubbed.endsWith('…')).toBe(true);
  });

  it('is empty for anything that is not a message', () => {
    expect(scrubErrorMessage(undefined)).toBe('');
    expect(scrubErrorMessage({ message: 'x' })).toBe('');
  });
});

describe('topStackFrame', () => {
  it('is the first real frame as file.ts:line, no directories', () => {
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      '    at new Promise (<anonymous>)',
      '    at readSpace (/Users/dylan/Code/rigdash/apps/rig-desktop/out/main/index.js:1234:56)',
      '    at next (/x/y.ts:1:1)',
    ].join('\n');
    expect(topStackFrame(error)).toBe('index.js:1234');
  });

  it('reads frames with no function name, and file:// URLs', () => {
    const error = new Error('boom');
    error.stack =
      'Error: boom\n    at file:///Applications/Rig.app/Contents/Resources/app.asar/out/renderer/chunk-abc.js:9:2';
    expect(topStackFrame(error)).toBe('chunk-abc.js:9');
  });

  it('is empty without a stack', () => {
    expect(topStackFrame({ name: 'TypeError' })).toBe('');
    expect(topStackFrame(null)).toBe('');
  });
});

describe('small field scrubbers', () => {
  it('keeps model ids, versions and codes short and plain', () => {
    expect(scrubModelId('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(scrubModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]');
    expect(scrubModelId('  ')).toBeUndefined();
    expect(scrubVersion('2.1.149 (Claude Code)')).toBe('2.1.149');
    expect(scrubVersion('codex-cli 0.160.1')).toBe('0.160.1');
    expect(scrubVersion(null)).toBeNull();
    expect(scrubCode('EACCES')).toBe('eacces');
    expect(scrubCode('hash mismatch!')).toBe('hash_mismatch');
  });
});
