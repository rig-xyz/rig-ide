import { describe, expect, it } from 'vitest';
import { installErrorText } from './install-error-text';

describe('installErrorText', () => {
  const variants: unknown[] = [
    { type: 'unknown-dependency', id: 'codex' },
    { type: 'no-install-command', id: 'codex' },
    { type: 'permission-denied', message: 'EACCES', output: '' },
    { type: 'command-failed', message: 'exit 1', output: 'zsh: command not found: npm' },
    { type: 'command-failed', message: 'exit 6', output: 'curl: (6) Could not resolve host: chatgpt.com' },
    { type: 'command-failed', message: 'exit 1', output: 'something else' },
    { type: 'pty-open-failed', message: 'pty' },
    { type: 'not-detected-after-install', id: 'codex' },
    new Error('IPC closed'),
  ];

  it('gives every failure a plain sentence with a next step, never terminal advice or the raw output', () => {
    for (const error of variants) {
      const { title, description } = installErrorText(error, 'Codex');
      expect(title).toBe('Couldn’t install Codex');
      expect(description.length).toBeGreaterThan(20);
      expect(description).toMatch(/\.$/);
      expect(description).not.toMatch(/terminal|npm install|EACCES|exit \d|command not found/i);
      expect(description).not.toMatch(/ [-–—] |\(/);
    }
  });

  it('says why for the cases people can act on', () => {
    expect(installErrorText({ type: 'not-detected-after-install', id: 'codex' }, 'Codex').description).toBe(
      'The install finished, but Rig can’t find Codex yet. Press Check again, or quit and reopen Rig.'
    );
    expect(installErrorText({ type: 'command-failed', message: '', output: 'sh: npm: command not found' }, 'Codex').description).toContain(
      'doesn’t have Node'
    );
  });
});
