import { err } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AcpRuntimeClient } from '@main/core/acp/controller';
import { createRuntimeAcpSessions } from './dispatch';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * A space's agent that couldn't start used to reach the Room as its error
 * kind alone ("Claude couldn't start: new_session_failed"). These pin the
 * plain-language reason that replaces it.
 */
function sessionsFailingWith(error: unknown) {
  const client = {
    startSession: vi.fn().mockResolvedValue(err(error)),
    resumeSession: vi.fn().mockResolvedValue(err(error)),
  } as unknown as AcpRuntimeClient;
  return createRuntimeAcpSessions(async () => client);
}

const START = { conversationId: 'c1', providerId: 'claude', cwd: '/space' } as const;

describe('space session start failures', () => {
  it('shows the unrunnable-CLI reason as written', async () => {
    const reason =
      "Claude Code (/usr/local/bin/claude) is built for Intel Macs and this Mac can't run it. Reinstall it: curl -fsSL https://claude.ai/install.sh | bash";
    const acp = sessionsFailingWith({
      type: 'spawn_failed',
      cause: { name: 'cli-unrunnable', message: reason },
    });

    expect(await acp.startSession(START)).toEqual(err(reason));
  });

  it('explains a spawn failure inside the adapter instead of new_session_failed', async () => {
    const acp = sessionsFailingWith({
      type: 'new_session_failed',
      cause: { name: 'RequestError', message: 'Internal error: spawn Unknown system error -86' },
    });

    expect(await acp.startSession(START)).toEqual(
      err("This Mac can't run the installed Claude: it's built for a different processor. Reinstall it, then try again.")
    );
    expect(
      await acp.resumeSession({ ...START, providerId: 'codex', sessionId: 's1' })
    ).toEqual(
      err("This Mac can't run the installed Codex: it's built for a different processor. Reinstall it, then try again.")
    );
  });

  it('never shows a bare error kind', async () => {
    const acp = sessionsFailingWith({
      type: 'new_session_failed',
      cause: { name: 'RequestError', message: 'Internal error' },
    });

    expect(await acp.startSession(START)).toEqual(err("Claude couldn't open a session"));
  });
});
