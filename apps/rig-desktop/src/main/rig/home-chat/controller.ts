import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { ok } from '@emdash/shared';
import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { homeChatRunChannel } from '@shared/rig/home-chat';
import { resolveSelfUserId, rigAccountController } from '../account';
import { getFeed } from '../feed/relay';
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
  selfNames: async () => {
    const [account, feed] = await Promise.all([rigAccountController.me().catch(() => null), getFeed().catch(() => null)]);
    return [account?.success ? account.data.name : null, feed?.success ? feed.data.me : null].filter((n): n is string => !!n);
  },
  onRun: (run) => events.emit(homeChatRunChannel, { run }),
  log,
});

export const rigHomeChatController = createRPCController({
  open: () => homeChat.open(),
  ask: (input: { text: string }) => homeChat.ask(input.text),
  stop: () => homeChat.stop(),
  runs: async () => homeChat.runs(),
  turnContext: async () => homeChat.turnContext(),
  send: (input: { text: string }) => homeChat.send(input.text),
  reset: () => homeChat.reset(),
});
