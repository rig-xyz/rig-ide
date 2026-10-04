import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `deleteAccount`: reads the account while the token still works, asks the
 * relay, then signs this computer out the way `logout` does.
 */

vi.mock('./config', () => ({ readRelayToken: async () => 'rpat_token' }));

const calls: string[] = [];
const account = vi.hoisted(() => ({
  getCurrentAccountId: vi.fn(),
  requestAccountDeletion: vi.fn(),
  forgetSelfUserId: vi.fn(),
}));
const pauseRigsForAccount = vi.hoisted(() => vi.fn(async () => {}));
const spawn = vi.hoisted(() => vi.fn());

vi.mock('./account', () => account);
vi.mock('./rig-controls', () => ({ pauseRigsForAccount, resumeRigsForAccount: vi.fn() }));
vi.mock('./sync-health', () => ({ getAccountBindingIds: vi.fn(async () => new Set(['bnd_1'])) }));
vi.mock('./local-cache-account', () => ({ purgeLocalCaches: vi.fn(async () => {}) }));
vi.mock('./notifications/electron', () => ({ restartNotifications: vi.fn() }));
vi.mock('./bundled-cli', () => ({ resolveCliBin: () => '/bin/rig' }));
vi.mock('node:child_process', () => ({ spawn }));

describe('deleteAccount', () => {
  beforeEach(() => {
    calls.length = 0;
    account.getCurrentAccountId.mockImplementation(async () => {
      calls.push('whoami');
      return { status: 'known', id: 'usr_1' };
    });
    spawn.mockImplementation((_bin: string, args: string[]) => {
      calls.push(args.join(' '));
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      setTimeout(() => child.emit('close', 0), 0);
      return child;
    });
    pauseRigsForAccount.mockClear();
  });

  it('reads the account, asks the relay, then signs out and pauses that account', async () => {
    account.requestAccountDeletion.mockImplementation(async () => {
      calls.push('delete');
      return {
        success: true,
        data: { deletionScheduledAt: '2026-10-11T12:00:00.000Z', alreadyScheduled: false },
      };
    });
    const { rigAuthController } = await import('./auth');
    const result = await rigAuthController.deleteAccount();
    expect(result).toEqual({
      success: true,
      data: {
        deletionScheduledAt: '2026-10-11T12:00:00.000Z',
        alreadyScheduled: false,
        signedOut: true,
      },
    });
    expect(calls).toEqual(['whoami', 'delete', 'logout --plain']);
    expect(pauseRigsForAccount).toHaveBeenCalledWith('usr_1', new Set(['bnd_1']));
  });

  it('stays signed in when the relay refuses', async () => {
    account.requestAccountDeletion.mockImplementation(async () => {
      calls.push('delete');
      return { success: false, error: { kind: 'relay', message: 'nope' } };
    });
    const { rigAuthController } = await import('./auth');
    const result = await rigAuthController.deleteAccount();
    expect(result.success).toBe(false);
    expect(calls).toEqual(['whoami', 'delete']);
    expect(pauseRigsForAccount).not.toHaveBeenCalled();
  });
});
