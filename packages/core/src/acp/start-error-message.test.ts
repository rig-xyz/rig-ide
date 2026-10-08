import { describe, expect, it } from 'vitest';
import { describeAgentStartError, describeSpawnFailure } from './start-error-message';

describe('describeAgentStartError', () => {
  it('passes an unrunnable-CLI reason through as written', () => {
    const reason =
      "Claude Code (/usr/local/bin/claude) is built for Intel Macs and this Mac can't run it. Reinstall it: curl -fsSL https://claude.ai/install.sh | bash";
    expect(
      describeAgentStartError(
        { type: 'spawn_failed', cause: { name: 'cli-unrunnable', message: reason } },
        'Claude'
      )
    ).toBe(reason);
  });

  it("explains the adapter's spawn failure instead of new_session_failed", () => {
    // What claude-agent-acp answers when the host claude binary is Intel-only
    // on a Mac without Rosetta (see agentRequestError in the runtime).
    const error = {
      type: 'new_session_failed',
      cause: { name: 'RequestError', message: 'Internal error: spawn Unknown system error -86' },
    };
    expect(describeAgentStartError(error, 'Claude')).toBe(
      "This Mac can't run the installed Claude: it's built for a different processor. Reinstall it, then try again."
    );
  });

  it('uses a phrase for the kind when the message says nothing', () => {
    expect(
      describeAgentStartError(
        { type: 'new_session_failed', cause: { name: 'RequestError', message: 'Internal error' } },
        'Codex'
      )
    ).toBe("Codex couldn't open a session");
    expect(describeAgentStartError({ type: 'initialize_failed' })).toBe(
      "The agent didn't finish starting up"
    );
  });

  it('keeps any other message as it is', () => {
    expect(
      describeAgentStartError({ type: 'auth_required', message: 'Authentication required' }, 'Claude')
    ).toBe('Authentication required');
  });
});

describe('describeSpawnFailure', () => {
  it.each([
    ['spawn EBADARCH', 'built for a different processor'],
    ['spawn /usr/local/bin/claude ENOEXEC', 'built for a different processor'],
    ['Bad CPU type in executable', 'built for a different processor'],
    ['spawn /usr/local/bin/claude EACCES', "isn't allowed to run the installed Claude"],
    ['spawn claude ENOENT', "Rig couldn't find Claude"],
  ])('maps %s', (text, expected) => {
    expect(describeSpawnFailure(text, 'Claude')).toContain(expected);
  });

  it('says to install an agent that was never found, not to reinstall it', () => {
    expect(describeSpawnFailure('spawn claude ENOENT', 'Claude')).toBe(
      "Rig couldn't find Claude on this Mac. Install Claude, then try again."
    );
  });

  it('leaves other text alone', () => {
    expect(describeSpawnFailure('rate limited', 'Claude')).toBeNull();
    expect(
      describeSpawnFailure("ENOENT: no such file or directory, open '/x/.claude.json'", 'Claude')
    ).toBeNull();
  });
});
