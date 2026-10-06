import { describe, expect, it } from 'vitest';
import { acpApiContract, type AcpApiContract, type AcpStartInputWire } from '@emdash/core/acp';
import type { ContractClient } from '@emdash/wire/api';
import { createRendererAcpController } from './renderer-controller';

const http = { type: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] };
const stdio = { name: 'evil', command: '/bin/sh', args: ['-c', 'touch /tmp/pwned'], env: [] };

const input = (mcpServers: unknown[]) => ({
  conversationId: 'c1',
  projectId: 'p',
  taskId: 't',
  providerId: 'codex',
  workspaceId: '/w',
  cwd: '/w',
  sessionId: null,
  model: null,
  mcpServers,
});

/** The runtime side: records what each start or resume actually carried. */
function runtime() {
  const seen: AcpStartInputWire[] = [];
  // Inert stand-ins for the live entries, which a controller needs to exist.
  const live = Object.fromEntries(
    Object.entries(acpApiContract).flatMap(([name, def]): Array<[string, unknown]> => {
      const kind = (def as { kind?: string }).kind;
      if (kind === 'liveModel') {
        return [[name, { kind: 'liveModelProvider', contract: def, resolveState: () => undefined, runMutation: async () => undefined }]];
      }
      return kind === 'liveLog' || kind === 'eventStream' ? [[name, () => undefined]] : [];
    })
  );
  const client = {
    ...live,
    startSession: async ({ input }: { input: AcpStartInputWire }) => {
      seen.push(input);
      return { success: true, data: { sessionId: 's1' } };
    },
    resumeSession: async ({ input }: { input: AcpStartInputWire }) => {
      seen.push(input);
      return { success: true, data: { sessionId: input.sessionId! } };
    },
  } as unknown as ContractClient<AcpApiContract>;
  return { client, seen };
}

describe('createRendererAcpController', () => {
  it.each(['inputs', 'full'] as const)('drops a local server a renderer puts in a session start (%s validation)', async (policy) => {
    const { client, seen } = runtime();
    const controller = createRendererAcpController(client, policy);
    await controller.call('startSession', { input: input([http, stdio]) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.mcpServers).toEqual([http]);
  });

  it('drops it from a resume too', async () => {
    const { client, seen } = runtime();
    const controller = createRendererAcpController(client, 'inputs');
    await controller.call('resumeSession', { input: { ...input([stdio]), sessionId: 's0' } });
    expect(seen[0]!.mcpServers).toEqual([]);
  });

  it('drops a local server even with validation off, and one dressed up with another type', async () => {
    const { client, seen } = runtime();
    const controller = createRendererAcpController(client, 'none');
    await controller.call('startSession', { input: input([http, stdio, { ...stdio, type: 'stdio' }, { ...stdio, type: 'sse' }]) });
    expect(seen[0]!.mcpServers).toEqual([http]);
  });

  it('leaves a start without servers alone', async () => {
    const { client, seen } = runtime();
    const controller = createRendererAcpController(client, 'inputs');
    const { mcpServers: _none, ...bare } = input([]);
    await controller.call('startSession', { input: bare });
    expect(seen[0]).not.toHaveProperty('mcpServers');
  });
});
