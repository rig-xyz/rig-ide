import { describe, expect, it, vi } from 'vitest';

/**
 * A packaged Rig runs its own bundled CLI: no sign-in or create error may
 * tell its user to open a terminal or run npm. Dev builds keep those hints.
 */

const mockApp = vi.hoisted(() => ({ isPackaged: true }));
vi.mock('electron', () => ({ app: mockApp }));
vi.mock('@main/lib/telemetry', () => ({ telemetryService: { capture: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { cliMissingMessage, noSignInLinkMessage, signInTimedOutMessage } = await import('./cli-advice');
const { interpretInitFailure } = await import('./create');

const TERMINAL_ADVICE = /npm|in a terminal|rig login/i;

describe('CLI advice in a packaged app', () => {
  it('never says npm or terminal in sign-in or create errors', () => {
    const messages = [
      cliMissingMessage('/Applications/Rig.app/Contents/Resources/rig'),
      signInTimedOutMessage(),
      noSignInLinkMessage(),
      interpretInitFailure({ kind: 'spawnFailed', bin: '/Applications/Rig.app/Contents/Resources/rig' })?.message ?? '',
    ];
    for (const message of messages) {
      expect(message).not.toMatch(TERMINAL_ADVICE);
      expect(message).toMatch(/\.$/);
    }
    expect(signInTimedOutMessage()).toBe('Sign-in timed out. Try again.');
    expect(cliMissingMessage('rig')).toBe('Rig couldn’t start one of its parts. Reinstall Rig from userig.xyz.');
  });

  it('keeps the terminal hints for a dev build', () => {
    expect(cliMissingMessage('rig', false)).toContain('npm i -g @rigxyz/cli');
    expect(signInTimedOutMessage(false)).toContain('in a terminal');
    expect(noSignInLinkMessage(false)).toContain('rig login');
  });
});
