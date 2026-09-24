import { err, ok, type Result } from '@emdash/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigAccountError } from '@shared/rig/account';
import { isError, resolveContext } from './account';
import {
  createHttpSpacesRelayApi,
  type AgentRequest,
  type RelayApiError,
  type RoomMemberRow,
  type RoomMessageRow,
  type SessionAgent,
  type SessionEventRow,
  type SessionRun,
} from './spaces/relay-api';

/**
 * Spaces: everything the renderer's `RelayRoomSource` needs from the relay,
 * proxied through main — no HTTP call it makes and no realtime credential
 * it opens a connection with ever touches this device's long-lived PAT.
 *
 * `RelayRoomSource` used to hold that PAT directly (see its own header
 * comment, still there documenting the prior tradeoff) so it could make its
 * own `fetch`/WebSocket calls from the renderer — the one deliberate
 * departure from "every relay call goes through main" in this codebase.
 * tap-spaces' `feat/spaces-relay` now mints short-lived, single-binding
 * realtime tickets (`POST /v1/me/bindings/:id/realtime-ticket`, ~10 minute
 * TTL — see `SPACES_NOTES.md`'s "Realtime ticket" section) specifically so
 * the renderer never needs the PAT at all: this module mints them, and
 * every plain HTTP call `RelayRoomSource` used to make directly is now a
 * thin proxy over `SpacesRelayApi` (the same relay client
 * `session-publisher.ts`/`request-claim.ts`/`dispatch.ts` already use),
 * reused rather than re-wrapped.
 *
 * `getConnectionInfo` intentionally no longer returns a token of any kind —
 * `mintRealtimeTicket` is the only credential this controller ever hands
 * the renderer, and it's scoped to one binding and ~10 minutes.
 */

export type SpacesConnectionInfo = {
  relayUrl: string;
  wsUrl: string;
  selfUserId: string;
};

function toWsUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/v1/realtime';
  return url.toString();
}

const api = createHttpSpacesRelayApi();

export const rigSpacesConnectionController = createRPCController({
  getConnectionInfo: async (): Promise<Result<SpacesConnectionInfo, RigAccountError>> => {
    const ctx = await resolveContext();
    if (isError(ctx)) return err(ctx);

    const who = await api.whoami();
    if (!who.success) return err(who.error);

    return ok({
      relayUrl: ctx.url,
      wsUrl: toWsUrl(ctx.url),
      selfUserId: who.data.id,
    });
  },

  /** Mints this Room's realtime credential — see this file's own header comment. Re-mint before `expiresAt`, and on every reconnect. */
  mintRealtimeTicket: async (input: {
    bindingId: string;
  }): Promise<Result<{ ticket: string; expiresAt: string }, RelayApiError>> =>
    api.mintRealtimeTicket(input.bindingId),

  listMembers: async (input: { bindingId: string }): Promise<Result<RoomMemberRow[], RelayApiError>> =>
    api.listMembers(input.bindingId),

  listMessages: async (input: {
    bindingId: string;
    query: { latest?: number; after?: string };
  }): Promise<Result<RoomMessageRow[], RelayApiError>> => api.listMessages(input.bindingId, input.query),

  getSessionEvents: async (input: {
    bindingId: string;
    runId: string;
    after?: number;
  }): Promise<Result<{ run: SessionRun; events: SessionEventRow[] }, RelayApiError>> =>
    api.getSessionEvents(input.bindingId, input.runId, input.after),

  postMessage: async (input: {
    bindingId: string;
    body: string;
    kind?: string;
    meta?: Record<string, unknown>;
  }): Promise<Result<RoomMessageRow, RelayApiError>> =>
    api.postMessage(input.bindingId, { body: input.body, kind: input.kind, meta: input.meta }),

  /** Files an agent request targeting the SENDER's own agent — see `RelayRoomSource.requestOwnAgent`'s own doc comment for why it's never a teammate's. */
  requestOwnAgent: async (input: {
    bindingId: string;
    targetOwnerUserId: string;
    targetAgent: SessionAgent;
    prompt: string;
    sourceMessageId?: string;
  }): Promise<Result<AgentRequest, RelayApiError>> =>
    api.createAgentRequest(input.bindingId, {
      targetOwnerUserId: input.targetOwnerUserId,
      targetAgent: input.targetAgent,
      prompt: input.prompt,
      sourceMessageId: input.sourceMessageId,
    }),
});
