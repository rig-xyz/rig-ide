import { describe, expect, it } from 'vitest';
import { extractRigAuthUrl, loginFailureMessage, logoutFailureMessage } from './auth-output';

const REAL_OUTPUT = [
  'Open this URL to log in:',
  'https://userig.xyz/auth/device?callback=http%3A%2F%2Flocalhost%3A54321%2Fcallback',
  '',
  'Waiting for sign-in...',
].join('\n');

describe('extractRigAuthUrl', () => {
  it('pulls the device auth URL out of the CLI output', () => {
    expect(extractRigAuthUrl(REAL_OUTPUT)).toBe(
      'https://userig.xyz/auth/device?callback=http%3A%2F%2Flocalhost%3A54321%2Fcallback'
    );
  });

  it('handles an unencoded callback query without swallowing the loopback URL', () => {
    const url = 'https://userig.xyz/auth/device?callback=http://localhost:5555/callback';
    expect(extractRigAuthUrl(`Open this URL to log in:\n${url}\n`)).toBe(url);
  });

  it('returns null before the URL has been printed', () => {
    expect(extractRigAuthUrl('')).toBeNull();
    expect(extractRigAuthUrl('rig login\nchecking credentials\n')).toBeNull();
  });

  it('never returns a bare loopback URL', () => {
    expect(extractRigAuthUrl('Listening on http://localhost:54321/callback\n')).toBeNull();
    expect(extractRigAuthUrl('Listening on http://127.0.0.1:54321/callback\n')).toBeNull();
  });

  it('falls back to the first non-loopback URL when the path changes', () => {
    const output = 'Callback: http://localhost:1234/callback\nOpen: https://hub.example/auth/v2/go';
    expect(extractRigAuthUrl(output)).toBe('https://hub.example/auth/v2/go');
  });

  it('strips sentence punctuation trailing the URL', () => {
    expect(extractRigAuthUrl('Visit https://userig.xyz/auth/device?x=1.')).toBe(
      'https://userig.xyz/auth/device?x=1'
    );
  });
});

describe('loginFailureMessage', () => {
  it('uses the last non-empty line the CLI printed', () => {
    expect(loginFailureMessage('starting\nLogin timed out after 5 minutes.\n\n', 1)).toBe(
      'Login timed out after 5 minutes.'
    );
  });

  it('falls back to the exit code when nothing was printed', () => {
    expect(loginFailureMessage('   \n\n', 3)).toBe('rig login exited with code 3.');
  });

  it('reports an unexpected stop when there is no exit code', () => {
    expect(loginFailureMessage('', null)).toBe('rig login stopped unexpectedly.');
  });
});

describe('logoutFailureMessage', () => {
  it('uses the last non-empty line the CLI printed', () => {
    expect(logoutFailureMessage('starting\nCould not write config.\n\n', 1)).toBe(
      'Could not write config.'
    );
  });

  it('falls back to the exit code when nothing was printed', () => {
    expect(logoutFailureMessage('   \n\n', 3)).toBe('rig logout exited with code 3.');
  });

  it('reports an unexpected stop when there is no exit code', () => {
    expect(logoutFailureMessage('', null)).toBe('rig logout stopped unexpectedly.');
  });
});
