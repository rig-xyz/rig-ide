import {
  agentConfigListSchema,
  type AgentConfigError,
  type AgentConfigList,
  type AuthStatusModelState,
} from '@emdash/core/workspace-server/agent-config';
import type { Result } from '@emdash/shared';
import { ReplicaLog, ReplicaState } from '@emdash/wire';
import { createImmutableMobxStore } from '@emdash/wire/util/mobx';
import type { Terminal } from '@xterm/xterm';
import {
  getAgentConfigRuntimeClient,
  type AgentConfigRuntimeRpcClient,
} from '@renderer/lib/agent-config/runtime-client';
import { createXtermLogSink } from '@renderer/lib/pty/xterm-log-sink';

/**
 * Ported near-verbatim from emdash-desktop's `renderer/lib/acp/auth-login-binding.ts`
 * (read-only reference) — same class, same wiring, only the import paths
 * adjusted to this app's own `agent-config`/`pty` locations (item 1/3 of
 * this round). Drives one agent's CLI sign-in: starts the login on the
 * already-running agent-config runtime process, streams its terminal output
 * into the caller's xterm `Terminal`, and exposes the live auth status as a
 * reactive `AuthStatusModelState` the sign-in dialog watches for
 * `'authenticated'`.
 */

type AuthStatusHandle = {
  readonly ready: Promise<void>;
  current(): AuthStatusModelState;
  dispose(): void;
};

export class AcpAuthLoginBinding {
  private disposed = false;

  private constructor(
    private readonly client: AgentConfigRuntimeRpcClient,
    readonly providerId: string,
    readonly status: AuthStatusHandle,
    private readonly output: ReplicaLog
  ) {}

  static async create(args: {
    providerId: string;
    methodId: string;
    terminal: Pick<Terminal, 'reset' | 'write'>;
  }): Promise<AcpAuthLoginBinding> {
    const client = await getAgentConfigRuntimeClient();
    const result = await client.startLogin({
      providerId: args.providerId,
      methodId: args.methodId,
    });
    if (!result.success) throw new Error(errorMessage(result));

    const key = { providerId: args.providerId };
    const agents = new ReplicaState(client.agents.state(undefined, 'list'), {
      schema: agentConfigListSchema,
      store: createImmutableMobxStore(),
    });
    const status = createAuthStatusHandle(args.providerId, agents);
    const output = new ReplicaLog(client.loginOutput.handle(key), {
      store: createXtermLogSink(args.terminal),
    });
    await Promise.all([status.ready, output.ready]);
    return new AcpAuthLoginBinding(client, args.providerId, status, output);
  }

  sendInput(data: string): void {
    if (this.disposed) return;
    void this.client.sendLoginInput({ providerId: this.providerId, data });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    void this.client.resizeLogin({ providerId: this.providerId, cols, rows });
  }

  markUrlHandled(urlId: string): void {
    if (this.disposed) return;
    void this.client.markUrlHandled({ providerId: this.providerId, urlId });
  }

  dispose(cancel = true): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.status.dispose();
    void this.output.dispose();
    if (cancel) void this.client.cancelLogin({ providerId: this.providerId });
  }
}

function createAuthStatusHandle(
  providerId: string,
  agents: ReplicaState<AgentConfigList>
): AuthStatusHandle {
  return {
    ready: agents.ready,
    current: () =>
      agents.current()[providerId]?.auth ?? { status: { kind: 'unknown' }, login: null },
    dispose: () => {
      void agents.dispose();
    },
  };
}

// D3 fix (divergence from the emdash port): emdash's own consumer of this
// helper never actually surfaces the type-only fallback to a user (its own
// `AgentSignInModal.tsx` just shows the bare string) — this app's version
// does, so a raw `AgentConfigError.type` (an internal code like
// `provider_not_supported`, meaningless out of context) showing up
// unexplained in the dialog is worth fixing here, not just formatting
// around it at the display layer. `AgentSignInDialog`'s own error render
// splits the parenthesized code back out for muted-mono styling.
function errorMessage(result: Result<unknown, AgentConfigError>): string {
  if (result.success) return '';
  return 'message' in result.error ? result.error.message : `Sign-in failed (${result.error.type})`;
}
