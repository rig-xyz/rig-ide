import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import type { RigAccountError } from '@shared/rig/account';
import { isError, resolveContext, type Resolved } from '../account';

/**
 * Spaces (lane 3): the relay's session-log, agent-request-queue, and room-
 * message HTTP surface (`tap-spaces/packages/relay/SPACES_NOTES.md`),
 * wrapped as one small, dependency-injectable interface.
 *
 * `SpacesRelayApi` exists so the session publisher (`session-publisher.ts`)
 * and the request claimer (`request-claim.ts`) never touch `fetch` or the
 * PAT directly — they take an `SpacesRelayApi` in their constructor and are
 * fully unit-testable against a hand-written fake. `createHttpSpacesRelayApi`
 * is the one real implementation, reusing `resolveContext()` from
 * `../account` (the same trust-gated `{url, token}` resolution `me()`/
 * `workspaces()` already use) so this module never re-derives the relay
 * trust gate on its own.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export type RelayApiError = RigAccountError;

export type SessionAgent = 'claude' | 'codex';
export type SessionStatus = 'running' | 'waiting' | 'done' | 'stopped' | 'failed';

export type SessionRun = {
  id: string;
  bindingId: string;
  ownerUserId: string;
  agent: SessionAgent;
  model: string | null;
  status: SessionStatus;
  title: string | null;
  commands: unknown;
  startedAt: string;
  endedAt: string | null;
};

export type SessionEventInput = { seq: number; kind: string; payload: Record<string, unknown> };
export type SessionEventRow = SessionEventInput & {
  runId: string;
  bytes: number;
  truncated: boolean;
  originalBytes: number | null;
  createdAt: string;
};

export type AgentRequestStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export type AgentRequest = {
  id: string;
  bindingId: string;
  targetOwnerUserId: string;
  targetAgent: SessionAgent;
  requestedByUserId: string;
  sourceMessageId: string | null;
  prompt: string;
  status: AgentRequestStatus;
  claimedByDeviceId: string | null;
  claimedAt: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RoomMemberRow = {
  userId: string;
  name: string | null;
  role: string;
};

export type BindingDevice = { id: string; bindingId: string };

export type RoomMessageRow = {
  id: string;
  seq: number;
  author: { userId: string | null; name: string | null; avatarUrl: string | null; kind: string };
  kind: string;
  body: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

export interface SpacesRelayApi {
  /** Who this device is acting as — needed to tell "my" agent requests apart, and to label outgoing messages. */
  whoami(): Promise<Result<{ id: string }, RelayApiError>>;

  createSession(
    bindingId: string,
    input: { agent: SessionAgent; model?: string | null; title?: string | null }
  ): Promise<Result<SessionRun, RelayApiError>>;
  patchSession(
    bindingId: string,
    runId: string,
    patch: { status?: SessionStatus; title?: string }
  ): Promise<Result<SessionRun, RelayApiError>>;
  postSessionEvents(
    bindingId: string,
    runId: string,
    events: SessionEventInput[]
  ): Promise<Result<{ inserted: number; upToSeq: number | null }, RelayApiError>>;
  getSessionEvents(
    bindingId: string,
    runId: string,
    after?: number
  ): Promise<Result<{ run: SessionRun; events: SessionEventRow[] }, RelayApiError>>;

  createAgentRequest(
    bindingId: string,
    input: {
      targetOwnerUserId: string;
      targetAgent: SessionAgent;
      prompt: string;
      sourceMessageId?: string | null;
    }
  ): Promise<Result<AgentRequest, RelayApiError>>;
  /** Cross-binding "my inbox" — `GET /v1/me/agent-requests?status=`. */
  listAgentRequests(status?: AgentRequestStatus): Promise<Result<AgentRequest[], RelayApiError>>;
  /** Atomic claim; a 409 (someone else already claimed it) surfaces as `{kind:'relay', status:409}`. */
  claimAgentRequest(
    bindingId: string,
    id: string,
    deviceId: string
  ): Promise<Result<AgentRequest, RelayApiError>>;
  patchAgentRequest(
    bindingId: string,
    id: string,
    patch: { status: AgentRequestStatus; runId?: string }
  ): Promise<Result<AgentRequest, RelayApiError>>;

  /**
   * Mints (or would mint a fresh one each call — callers should cache) a
   * device credential for THIS device on `bindingId`, via the relay's
   * member self-service route (`POST /v1/me/bindings/:id/devices`). Every
   * membership role may call it — no invite involved, the membership row
   * is the grant — so it works for the same account claiming requests on
   * any binding it's a member of, not just ones it owns.
   */
  mintDevice(bindingId: string, deviceLabel?: string): Promise<Result<BindingDevice, RelayApiError>>;

  listMembers(bindingId: string): Promise<Result<RoomMemberRow[], RelayApiError>>;
  listMessages(
    bindingId: string,
    query: { latest?: number; after?: string }
  ): Promise<Result<RoomMessageRow[], RelayApiError>>;
  postMessage(
    bindingId: string,
    input: { body: string; kind?: string; meta?: Record<string, unknown> }
  ): Promise<Result<RoomMessageRow, RelayApiError>>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function transportError(action: string, error: unknown): RelayApiError {
  log.warn('Rig spaces relay request failed', { action, error: String(error) });
  return { kind: 'relay', message: `Could not ${action} — the relay is unreachable.` };
}

async function relayError(response: Response, action: string): Promise<RelayApiError> {
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    const raw = asRecord(body)?.error;
    if (typeof raw === 'string') code = raw;
  } catch {
    // non-JSON body; the status alone has to do
  }
  if (response.status === 401 && code === 'invalid_token') {
    return { kind: 'invalidToken', message: 'Your sign-in has expired. Sign in again.' };
  }
  return {
    kind: 'relay',
    status: response.status,
    message: code
      ? `Could not ${action} (relay: ${code}).`
      : `Could not ${action} (relay ${response.status}).`,
  };
}

async function request(
  ctx: Resolved,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  action: string,
  body?: unknown
): Promise<Result<unknown, RelayApiError>> {
  const base = ctx.url.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return err(transportError(action, error));
  }
  if (!response.ok) return err(await relayError(response, action));
  try {
    return ok(await response.json());
  } catch (error) {
    return err(transportError(action, error));
  }
}

function shapeRun(raw: unknown): SessionRun | null {
  const r = asRecord(raw);
  if (!r || typeof r.id !== 'string') return null;
  return {
    id: r.id,
    bindingId: String(r.bindingId ?? ''),
    ownerUserId: String(r.ownerUserId ?? ''),
    agent: (r.agent as SessionAgent) ?? 'claude',
    model: typeof r.model === 'string' ? r.model : null,
    status: (r.status as SessionStatus) ?? 'running',
    title: typeof r.title === 'string' ? r.title : null,
    commands: r.commands ?? null,
    startedAt: String(r.startedAt ?? ''),
    endedAt: typeof r.endedAt === 'string' ? r.endedAt : null,
  };
}

function shapeRequest(raw: unknown): AgentRequest | null {
  const r = asRecord(raw);
  if (!r || typeof r.id !== 'string') return null;
  return {
    id: r.id,
    bindingId: String(r.bindingId ?? ''),
    targetOwnerUserId: String(r.targetOwnerUserId ?? ''),
    targetAgent: (r.targetAgent as SessionAgent) ?? 'claude',
    requestedByUserId: String(r.requestedByUserId ?? ''),
    sourceMessageId: typeof r.sourceMessageId === 'string' ? r.sourceMessageId : null,
    prompt: String(r.prompt ?? ''),
    status: (r.status as AgentRequestStatus) ?? 'queued',
    claimedByDeviceId: typeof r.claimedByDeviceId === 'string' ? r.claimedByDeviceId : null,
    claimedAt: typeof r.claimedAt === 'string' ? r.claimedAt : null,
    runId: typeof r.runId === 'string' ? r.runId : null,
    createdAt: String(r.createdAt ?? ''),
    updatedAt: String(r.updatedAt ?? ''),
  };
}

/** The one real `SpacesRelayApi`, resolving `{url, token}` fresh on every call (same reasoning as `account.ts`'s `resolveContext`: a mid-session sign-in takes effect immediately). */
export function createHttpSpacesRelayApi(): SpacesRelayApi {
  async function ctxOrError(): Promise<Result<Resolved, RelayApiError>> {
    const ctx = await resolveContext();
    return isError(ctx) ? err(ctx) : ok(ctx);
  }

  return {
    async whoami() {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(ctxResult.data, 'GET', '/v1/me', 'load your account');
      if (!result.success) return err(result.error);
      const id = asRecord(result.data)?.user && asRecord(asRecord(result.data)?.user)?.id;
      if (typeof id !== 'string') {
        return err<RelayApiError>({ kind: 'relay', message: 'Could not load your account.' });
      }
      return ok({ id });
    },

    async createSession(bindingId, input) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'POST',
        `/v1/me/bindings/${bindingId}/sessions`,
        'start a session',
        input
      );
      if (!result.success) return err(result.error);
      const run = shapeRun(asRecord(result.data)?.run);
      if (!run) return err<RelayApiError>({ kind: 'relay', message: 'Could not start a session.' });
      return ok(run);
    },

    async patchSession(bindingId, runId, patch) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'PATCH',
        `/v1/me/bindings/${bindingId}/sessions/${runId}`,
        'update the session',
        patch
      );
      if (!result.success) return err(result.error);
      const run = shapeRun(asRecord(result.data)?.run);
      if (!run) {
        return err<RelayApiError>({ kind: 'relay', message: 'Could not update the session.' });
      }
      return ok(run);
    },

    async postSessionEvents(bindingId, runId, events) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'POST',
        `/v1/me/bindings/${bindingId}/sessions/${runId}/events`,
        'publish session events',
        { events }
      );
      if (!result.success) return err(result.error);
      const raw = asRecord(result.data);
      return ok({
        inserted: typeof raw?.inserted === 'number' ? raw.inserted : 0,
        upToSeq: typeof raw?.upToSeq === 'number' ? raw.upToSeq : null,
      });
    },

    async getSessionEvents(bindingId, runId, after) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const query = after !== undefined ? `?after=${after}` : '';
      const result = await request(
        ctxResult.data,
        'GET',
        `/v1/me/bindings/${bindingId}/sessions/${runId}/events${query}`,
        'load session events'
      );
      if (!result.success) return err(result.error);
      const raw = asRecord(result.data);
      const run = shapeRun(raw?.run);
      if (!run) {
        return err<RelayApiError>({ kind: 'relay', message: 'Could not load session events.' });
      }
      const events = Array.isArray(raw?.events)
        ? raw.events.map((e) => {
            const row = asRecord(e);
            return {
              runId,
              seq: Number(row?.seq ?? 0),
              kind: String(row?.kind ?? ''),
              payload: (row?.payload as Record<string, unknown>) ?? {},
              bytes: Number(row?.bytes ?? 0),
              truncated: Boolean(row?.truncated),
              originalBytes: typeof row?.originalBytes === 'number' ? row.originalBytes : null,
              createdAt: String(row?.createdAt ?? ''),
            };
          })
        : [];
      return ok({ run, events });
    },

    async createAgentRequest(bindingId, input) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'POST',
        `/v1/me/bindings/${bindingId}/agent-requests`,
        'send an agent request',
        input
      );
      if (!result.success) return err(result.error);
      const req = shapeRequest(asRecord(result.data)?.request);
      if (!req) {
        return err<RelayApiError>({ kind: 'relay', message: 'Could not send the agent request.' });
      }
      return ok(req);
    },

    async listAgentRequests(status = 'queued') {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'GET',
        `/v1/me/agent-requests?status=${status}`,
        'load agent requests'
      );
      if (!result.success) return err(result.error);
      const raw = asRecord(result.data)?.requests;
      const requests = Array.isArray(raw)
        ? raw.map(shapeRequest).filter((r): r is AgentRequest => r !== null)
        : [];
      return ok(requests);
    },

    async claimAgentRequest(bindingId, id, deviceId) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'POST',
        `/v1/me/bindings/${bindingId}/agent-requests/${id}/claim`,
        'claim the agent request',
        { deviceId }
      );
      if (!result.success) return err(result.error);
      const req = shapeRequest(asRecord(result.data)?.request);
      if (!req) {
        return err<RelayApiError>({ kind: 'relay', message: 'Could not claim the agent request.' });
      }
      return ok(req);
    },

    async patchAgentRequest(bindingId, id, patch) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'PATCH',
        `/v1/me/bindings/${bindingId}/agent-requests/${id}`,
        'update the agent request',
        patch
      );
      if (!result.success) return err(result.error);
      const req = shapeRequest(asRecord(result.data)?.request);
      if (!req) {
        return err<RelayApiError>({ kind: 'relay', message: 'Could not update the agent request.' });
      }
      return ok(req);
    },

    async mintDevice(bindingId, deviceLabel) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'POST',
        `/v1/me/bindings/${bindingId}/devices`,
        'register this device',
        deviceLabel ? { deviceLabel } : {}
      );
      if (!result.success) return err(result.error);
      const device = asRecord(asRecord(result.data)?.device);
      if (!device || typeof device.id !== 'string') {
        return err<RelayApiError>({ kind: 'relay', message: 'Could not register this device.' });
      }
      return ok({ id: device.id, bindingId });
    },

    async listMembers(bindingId) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'GET',
        `/v1/me/bindings/${bindingId}/members`,
        'load room members'
      );
      if (!result.success) return err(result.error);
      const raw = asRecord(result.data)?.members;
      const members = Array.isArray(raw)
        ? raw
            .map((m) => {
              const row = asRecord(m);
              if (!row || typeof row.userId !== 'string') return null;
              return {
                userId: row.userId,
                name: typeof row.name === 'string' ? row.name : null,
                role: typeof row.role === 'string' ? row.role : 'viewer',
              };
            })
            .filter((m): m is RoomMemberRow => m !== null)
        : [];
      return ok(members);
    },

    async listMessages(bindingId, query) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const params = new URLSearchParams();
      if (query.latest !== undefined) params.set('latest', String(query.latest));
      if (query.after !== undefined) params.set('after', query.after);
      const qs = params.toString();
      const result = await request(
        ctxResult.data,
        'GET',
        `/v1/me/bindings/${bindingId}/messages${qs ? `?${qs}` : ''}`,
        'load room messages'
      );
      if (!result.success) return err(result.error);
      const raw = asRecord(result.data)?.messages;
      const messages = Array.isArray(raw)
        ? raw
            .map((m) => {
              const row = asRecord(m);
              if (!row || typeof row.id !== 'string') return null;
              const author = asRecord(row.author);
              return {
                id: row.id,
                seq: Number(row.seq ?? 0),
                author: {
                  userId: typeof author?.userId === 'string' ? author.userId : null,
                  name: typeof author?.name === 'string' ? author.name : null,
                  avatarUrl: typeof author?.avatarUrl === 'string' ? author.avatarUrl : null,
                  kind: typeof author?.kind === 'string' ? author.kind : 'user',
                },
                kind: typeof row.kind === 'string' ? row.kind : 'text',
                body: typeof row.body === 'string' ? row.body : '',
                meta: asRecord(row.meta),
                createdAt: String(row.createdAt ?? ''),
              };
            })
            .filter((m): m is RoomMessageRow => m !== null)
        : [];
      return ok(messages);
    },

    async postMessage(bindingId, input) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'POST',
        `/v1/me/bindings/${bindingId}/messages`,
        'send the message',
        input
      );
      if (!result.success) return err(result.error);
      const row = asRecord(result.data)?.message;
      const raw = asRecord(row);
      if (!raw || typeof raw.id !== 'string') {
        return err<RelayApiError>({ kind: 'relay', message: 'Could not send the message.' });
      }
      const author = asRecord(raw.author);
      return ok({
        id: raw.id,
        seq: Number(raw.seq ?? 0),
        author: {
          userId: typeof author?.userId === 'string' ? author.userId : null,
          name: typeof author?.name === 'string' ? author.name : null,
          avatarUrl: typeof author?.avatarUrl === 'string' ? author.avatarUrl : null,
          kind: typeof author?.kind === 'string' ? author.kind : 'user',
        },
        kind: typeof raw.kind === 'string' ? raw.kind : 'text',
        body: typeof raw.body === 'string' ? raw.body : '',
        meta: asRecord(raw.meta),
        createdAt: String(raw.createdAt ?? ''),
      });
    },
  };
}
