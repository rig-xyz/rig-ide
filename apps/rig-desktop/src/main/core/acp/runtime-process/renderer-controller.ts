import { acpApiContract, isHttpMcpServer, type AcpApiContract, type AcpStartInputWire } from '@emdash/core/acp';
import { forwardController, withValidation, type ContractClient, type Controller, type ValidatePolicy } from '@emdash/wire/api';

type AcpRuntimeClient = ContractClient<AcpApiContract>;

/**
 * The ACP runtime as the renderer reaches it. A session start's
 * `mcpServers` may hold local (stdio) servers, which the agent runs as
 * commands; those may only come from the main process. So every server but
 * the remote (http) ones is dropped from a renderer's start or resume here,
 * after validation and before the runtime sees it: a renderer can never make
 * the runtime spawn a command.
 */
export function createRendererAcpController(client: AcpRuntimeClient, policy: ValidatePolicy): Controller {
  return withValidation(acpApiContract, forwardController(acpApiContract, withoutLocalMcpServers(client)), policy);
}

function withoutLocalMcpServers(client: AcpRuntimeClient): AcpRuntimeClient {
  const strip = <T extends { input: AcpStartInputWire }>(command: T): T => {
    const servers = command.input.mcpServers;
    if (!servers) return command;
    return { ...command, input: { ...command.input, mcpServers: servers.filter(isHttpMcpServer) } };
  };
  return {
    ...client,
    startSession: (input, meta) => client.startSession(strip(input), meta),
    resumeSession: (input, meta) => client.resumeSession(strip(input), meta),
  };
}
