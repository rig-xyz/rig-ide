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
  /** Room message authors are identified by Clerk id, not `userId` — see `RelayRoomSource.ingestWireMessage`. */
  clerkUserId: string | null;
  name: string | null;
  email: string | null;
  role: string;
  /** Profile photo (the relay's `imageUrl`), when the person has one. */
  avatarUrl: string | null;
};

/** One invite as the Room shows it: who invited, whom (email) or a link, at what role. */
export type RoomInviteRow = {
  id: string;
  inviterUserId: string | null;
  email: string | null;
  role: string;
  revoked: boolean;
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
  /** Set on doc comments (the comments layer shares this table): the file, the thread parent, and the anchored passage. */
  path?: string | null;
  parentId?: string | null;
  quote?: string | null;
};

/** One connector a space uses, as the relay lists it. */
export type SpaceConnectorRow = { connectorId: string; addedBy: string; addedAt: string };

function shapeConnector(raw: unknown): SpaceConnectorRow | null {
  const r = asRecord(raw);
  if (!r || typeof r.connectorId !== 'string') return null;
  return { connectorId: r.connectorId, addedBy: String(r.addedBy ?? ''), addedAt: String(r.addedAt ?? '') };
}

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

  /**
   * Mints a short-lived (~10 minute), single-binding, single-user realtime
   * credential (`POST /v1/me/bindings/:id/realtime-ticket`) for opening a
   * `space:<bindingId>`/`file:<bindingId>:*` Hocuspocus connection WITHOUT
   * handing the renderer this device's long-lived PAT. See tap-spaces'
   * `SPACES_NOTES.md` "Realtime ticket" section for the full contract —
   * `expiresAt` is ISO 8601; re-mint well before it lapses for a connection
   * expected to outlive it, and on every reconnect (`onAuthenticate` runs
   * once per document open, so a stale ticket only breaks a NEW connection,
   * never one already established).
   */
  mintRealtimeTicket(
    bindingId: string
  ): Promise<Result<{ ticket: string; expiresAt: string }, RelayApiError>>;

  listMembers(bindingId: string): Promise<Result<RoomMemberRow[], RelayApiError>>;
  /** A space's pending invites (any member of a space may read them). */
  listInvites?(bindingId: string): Promise<Result<RoomInviteRow[], RelayApiError>>;
  /** The connectors a space uses (ids only, no secrets: each member's own login stays on their machine). */
  listConnectors?(bindingId: string): Promise<Result<SpaceConnectorRow[], RelayApiError>>;
  /** Adds one (owner/editor of a space; 403 otherwise). Already there: returns it, no second Room message. */
  addConnector?(bindingId: string, connectorId: string): Promise<Result<SpaceConnectorRow, RelayApiError>>;
  removeConnector?(bindingId: string, connectorId: string): Promise<Result<void, RelayApiError>>;
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

/** The exact passage a doc comment is anchored to, if any. */
function anchorQuote(anchor: unknown): string | null {
  const exact = asRecord(anchor)?.exact;
  return typeof exact === 'string' ? exact : null;
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  if (response.status === 204) return ok(null);
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
/**
 * Flags a binding as a space, or promotes a space back to a rig
 * (`PATCH /v1/me/bindings/:id {kind}`, owner only). Standalone rather than
 * on `SpacesRelayApi`: only space creation and promotion need it.
 */
export async function setBindingKind(
  bindingId: string,
  kind: 'rig' | 'space'
): Promise<Result<void, RelayApiError>> {
  const ctx = await resolveContext();
  if (isError(ctx)) return err(ctx);
  const result = await request(ctx, 'PATCH', `/v1/me/bindings/${bindingId}`, 'update the space', { kind });
  return result.success ? ok(undefined) : err(result.error);
}

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

    async mintRealtimeTicket(bindingId) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'POST',
        `/v1/me/bindings/${bindingId}/realtime-ticket`,
        'open a live connection',
        {}
      );
      if (!result.success) return err(result.error);
      const raw = asRecord(result.data);
      const ticket = raw?.ticket;
      const expiresAt = raw?.expiresAt;
      if (typeof ticket !== 'string' || typeof expiresAt !== 'string') {
        return err<RelayApiError>({ kind: 'relay', message: 'Could not open a live connection.' });
      }
      return ok({ ticket, expiresAt });
    },

    async listInvites(bindingId) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(ctxResult.data, 'GET', `/v1/me/bindings/${bindingId}/invites`, 'load invites');
      if (!result.success) return err(result.error);
      const raw = asRecord(result.data)?.invites;
      const invites = Array.isArray(raw)
        ? raw
            .map((i): RoomInviteRow | null => {
              const row = asRecord(i);
              if (!row || typeof row.id !== 'string') return null;
              return {
                id: row.id,
                inviterUserId: typeof row.inviterUserId === 'string' ? row.inviterUserId : null,
                email: typeof row.emailConstraint === 'string' ? row.emailConstraint : null,
                role: typeof row.role === 'string' ? row.role : 'editor',
                revoked: typeof row.revokedAt === 'string',
              };
            })
            .filter((i): i is RoomInviteRow => i !== null)
        : [];
      return ok(invites);
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
                clerkUserId: typeof row.clerkUserId === 'string' ? row.clerkUserId : null,
                name: typeof row.name === 'string' ? row.name : null,
                email: typeof row.email === 'string' ? row.email : null,
                role: typeof row.role === 'string' ? row.role : 'viewer',
                avatarUrl: typeof row.imageUrl === 'string' ? row.imageUrl : null,
              };
            })
            .filter((m): m is RoomMemberRow => m !== null)
        : [];
      return ok(members);
    },

    async listConnectors(bindingId) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(ctxResult.data, 'GET', `/v1/me/bindings/${bindingId}/connectors`, 'load space connectors');
      if (!result.success) return err(result.error);
      const raw = asRecord(result.data)?.connectors;
      return ok(Array.isArray(raw) ? raw.map(shapeConnector).filter((c): c is SpaceConnectorRow => c !== null) : []);
    },

    async addConnector(bindingId, connectorId) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(ctxResult.data, 'POST', `/v1/me/bindings/${bindingId}/connectors`, 'add the connector', {
        connectorId,
      });
      if (!result.success) return err(result.error);
      const connector = shapeConnector(asRecord(result.data)?.connector);
      return connector ? ok(connector) : err<RelayApiError>({ kind: 'relay', message: 'Could not add the connector.' });
    },

    async removeConnector(bindingId, connectorId) {
      const ctxResult = await ctxOrError();
      if (!ctxResult.success) return err(ctxResult.error);
      const result = await request(
        ctxResult.data,
        'DELETE',
        `/v1/me/bindings/${bindingId}/connectors/${encodeURIComponent(connectorId)}`,
        'remove the connector'
      );
      return result.success ? ok(undefined) : err(result.error);
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
            .map((m): RoomMessageRow | null => {
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
                path: typeof row.path === 'string' ? row.path : null,
                parentId: typeof row.parentId === 'string' ? row.parentId : null,
                quote: anchorQuote(row.anchor),
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
