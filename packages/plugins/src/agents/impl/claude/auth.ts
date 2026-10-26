import type {
  AgentAuthContext,
  AgentAuthCredential,
  AgentAuthStatus,
} from '@emdash/core/agents/plugins';
import { authenticatedFromEnv } from '../../helpers/auth';

const AUTH_STATUS_TIMEOUT_MS = 5_000;
const LOGGED_OUT_PATTERN = /not (authenticated|logged in|signed in)|login required|logged out/i;

type ExecErrorWithOutput = {
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
};

/**
 * A key in the environment Rig launches Claude with wins over a login, so it
 * reads as `api-key` without asking the CLI. Otherwise `claude auth status`
 * says how: an account (or a claude.ai/OAuth method) is a Claude login.
 */
export async function claudeAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  const envStatus = authenticatedFromEnv(ctx, ['ANTHROPIC_API_KEY']);
  if (envStatus.kind === 'authenticated') return { ...envStatus, method: 'api-key' };

  try {
    const { stdout } = await ctx.exec(ctx.cli, ['auth', 'status'], {
      timeout: AUTH_STATUS_TIMEOUT_MS,
    });
    const account = accountFromAuthStatus(stdout);
    return { kind: 'authenticated', account, method: methodFromAuthStatus(stdout, account) };
  } catch (error) {
    const output = outputFromExecError(error);
    if (isExitCode(error, 1) && isAuthStatusResponse(output)) {
      return { kind: 'unauthenticated' };
    }
    return { kind: 'unknown' };
  }
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === 'object' && error !== null && (error as ExecErrorWithOutput).code === code
  );
}

function isAuthStatusResponse(output: ExecErrorOutput): boolean {
  if (parseAuthStatus(output.stdout)) return true;
  return LOGGED_OUT_PATTERN.test(output.combined);
}

function accountFromAuthStatus(output: string): string | undefined {
  const status = parseAuthStatus(output);
  const oauthAccount = objectValue(status?.oauthAccount);
  return firstString(
    status?.email,
    status?.account,
    status?.accountEmail,
    oauthAccount?.emailAddress,
    oauthAccount?.email
  );
}

function methodFromAuthStatus(output: string, account: string | undefined): AgentAuthCredential {
  const status = parseAuthStatus(output);
  const method = typeof status?.authMethod === 'string' ? status.authMethod : '';
  if (/api[\s_-]?key/i.test(method) || isKeySource(status?.apiKeySource)) return 'api-key';
  if (account || /claude\.ai|oauth/i.test(method)) return 'claude-ai';
  return 'unknown';
}

function isKeySource(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value !== 'none';
}

function parseAuthStatus(output: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(output);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type ExecErrorOutput = {
  stdout: string;
  combined: string;
};

function outputFromExecError(error: unknown): ExecErrorOutput {
  if (typeof error !== 'object' || error === null) {
    const message = String(error);
    return { stdout: '', combined: message };
  }
  const withOutput = error as ExecErrorWithOutput;
  const stdout = typeof withOutput.stdout === 'string' ? withOutput.stdout : '';
  const combined = [withOutput.stdout, withOutput.stderr, withOutput.message]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return { stdout, combined };
}
