import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { ok } from '@emdash/shared';
import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { resolveSelfUserId } from '../account';
import { createRuntimeAcpSessions } from '../spaces/dispatch';
import { rigToolsServer } from '../spaces/rig-tools-instance';
import { createHomeChat } from './chat';
import { turnGate } from '../orch/turns';

/**
 * `rpc.rig.homeChat`: Home's chat with the person's own Claude on this Mac
 * (chat.ts). Boot wiring only; tests use `createHomeChat` with fakes.
 */
const homeChat = createHomeChat({
  acp: createRuntimeAcpSessions(getAcpRuntimeClient),
  rigTools: (scope) => rigToolsServer.serverFor(scope),
  whoami: async () => {
    const id = await resolveSelfUserId();
    return id.success ? ok({ id: id.data }) : id;
  },
  cwd: async () => {
    const dir = join(app.getPath('userData'), 'home-chat');
    await mkdir(dir, { recursive: true });
    return dir;
  },
  newConversationId: () => `home-${randomUUID()}`,
  issueTurn: () => turnGate.issue('chat'),
  log,
});

export const rigHomeChatController = createRPCController({
  send: (input: { text: string }) => homeChat.send(input.text),
  reset: () => homeChat.reset(),
});
