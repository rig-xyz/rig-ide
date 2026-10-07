import { describe, expect, it } from 'vitest';
import { agentCliSource, classifyAgentRunFailure, isSignInFailure } from './agent-run-failure';

describe('classifyAgentRunFailure', () => {
  it('an old Codex, in either wording the provider uses, is outdated_cli', () => {
    expect(
      classifyAgentRunFailure(
        '{"type":"error","error":{"message":"The \'gpt-6.1-sol\' model requires a newer version of Codex."}}',
        'run'
      )
    ).toBe('outdated_cli');
    expect(
      classifyAgentRunFailure(
        'Warning: x\n{"error":{"message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}',
        'run'
      )
    ).toBe('outdated_cli');
  });

  it('a model the account cannot use, without the old-CLI wording, is model_unsupported', () => {
    expect(classifyAgentRunFailure('model_not_found: claude-opus-9', 'run')).toBe(
      'model_unsupported'
    );
    expect(classifyAgentRunFailure('The model `o9` does not exist', 'run')).toBe(
      'model_unsupported'
    );
  });

  it('sign-in, rate limit and network failures', () => {
    expect(classifyAgentRunFailure('Error: 401 Unauthorized', 'run')).toBe('auth');
    expect(classifyAgentRunFailure('Not logged in. Please run /login', 'start')).toBe('auth');
    expect(classifyAgentRunFailure('429 Too Many Requests', 'run')).toBe('rate_limit');
    expect(classifyAgentRunFailure("You've hit your usage limit", 'run')).toBe('rate_limit');
    expect(
      classifyAgentRunFailure('fetch failed: getaddrinfo ENOTFOUND api.anthropic.com', 'run')
    ).toBe('network');
  });

  it('anything else is start_failed before the agent started, other after', () => {
    expect(classifyAgentRunFailure("Codex couldn't start: spawn EACCES", 'start')).toBe(
      'start_failed'
    );
    expect(classifyAgentRunFailure('the agent stopped with an error', 'run')).toBe('other');
    expect(classifyAgentRunFailure('', 'run')).toBe('other');
  });

  it('a run that went quiet is stalled, whatever its text', () => {
    expect(classifyAgentRunFailure('429', 'stalled')).toBe('stalled');
  });
});

describe('agentCliSource', () => {
  it('reads where the CLI came from off its resolved path', () => {
    expect(agentCliSource('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')).toBe(
      'chatgpt_app'
    );
    expect(agentCliSource('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')).toBe('npm');
    expect(agentCliSource('/Users/a/.nvm/versions/node/v22.1.0/bin/claude')).toBe('npm');
    expect(agentCliSource('/opt/homebrew/Caskroom/codex/0.160.1/codex')).toBe('homebrew');
    expect(agentCliSource('/usr/local/Cellar/claude/2.1.149/bin/claude')).toBe('homebrew');
    expect(agentCliSource('/Users/a/.local/bin/claude')).toBe('other');
    expect(agentCliSource(null)).toBeNull();
  });
});

describe('isSignInFailure', () => {
  it('reads an expired or missing CLI login as a sign-in failure', () => {
    expect(isSignInFailure('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
    expect(isSignInFailure('Not logged in · Please run /login')).toBe(true);
    expect(isSignInFailure('authentication_error: invalid x-api-key')).toBe(true);
  });

  it('leaves a run alone that only talks about credentials or auth', () => {
    expect(isSignInFailure('Could not read the credentials file in the repo')).toBe(false);
    expect(isSignInFailure('The authentication middleware returned 500')).toBe(false);
    expect(isSignInFailure('rate limit exceeded')).toBe(false);
  });
});
