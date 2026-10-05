import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { parseFrontmatter } from '@shared/core/skills/validation';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigAccountError } from '@shared/rig/account';
import { log } from '@main/lib/logger';
import type { MessageReaction } from '@shared/spaces/reactions';
import type { ThemeEventsPage, ThemesFetch, ThemesSnapshotWire } from '@shared/spaces/themes';
import { isError, resolveContext, resolveSelfUserId } from './account';
import {
  createHttpSpacesRelayApi,
  type AgentRequest,
  type RelayApiError,
  type RoomInviteRow,
  type RoomMemberRow,
  type RoomMessageRow,
  type SessionAgent,
  type SessionEventRow,
  type SessionRun,
  type SpaceConnectorRow,
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

/** One of a space's own skills, for the Room's `/` palette. */
export type SpaceSkill = { cmd: string; name: string; desc: string };

/**
 * The relay's draft preview (`POST /v1/me/bindings/:id/draft-preview`):
 * whether the message being typed answers one of your own agent's recent
 * turns (`answersTo`, a room message id), and how sure Jev is. Anything
 * short of a clear answer is "none".
 *
 * A newer relay also says who the draft is for (`recipient`) and what the
 * router would do with it (`action`): `ask` your own agent right away,
 * `suggest` asking it after the send, or `none`. An older relay sends
 * neither, and the composer behaves as it always did.
 */
export type DraftRecipient =
  | { kind: 'agent'; agentId: string; agent: SessionAgent; ownerUserId: string }
  | { kind: 'person'; userId: string }
  | { kind: 'none' };
export type DraftAction = 'ask' | 'suggest' | 'none';
export type DraftPreview = {
  answersTo: string | null;
  agent: SessionAgent | null;
  confidence: number;
  recipient?: DraftRecipient;
  action?: DraftAction;
};

const NO_DRAFT_PREVIEW: DraftPreview = { answersTo: null, agent: null, confidence: 0 };
/** The relay gives Jev 2s; past this the composer has moved on anyway. */
const DRAFT_PREVIEW_TIMEOUT_MS = 3000;

function isSessionAgent(value: unknown): value is SessionAgent {
  return value === 'claude' || value === 'codex';
}

function parseRecipient(raw: unknown): DraftRecipient | undefined {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (r?.kind === 'agent' && typeof r.agentId === 'string' && isSessionAgent(r.agent) && typeof r.ownerUserId === 'string')
    return { kind: 'agent', agentId: r.agentId, agent: r.agent, ownerUserId: r.ownerUserId };
  if (r?.kind === 'person' && typeof r.userId === 'string') return { kind: 'person', userId: r.userId };
  if (r?.kind === 'none') return { kind: 'none' };
  return undefined;
}

export function parseDraftPreview(raw: unknown): DraftPreview {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r) return NO_DRAFT_PREVIEW;
  const recipient = parseRecipient(r.recipient);
  const action: DraftAction | undefined =
    r.action === 'ask' || r.action === 'suggest' || r.action === 'none' ? r.action : undefined;
  const routing = { ...(recipient ? { recipient } : {}), ...(action ? { action } : {}) };
  if (typeof r.answersTo !== 'string' || !isSessionAgent(r.agent)) return { ...NO_DRAFT_PREVIEW, ...routing };
  const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 0;
  return { answersTo: r.answersTo, agent: r.agent, confidence, ...routing };
}

/**
 * The skills the space itself ships (`.claude/skills/<name>/SKILL.md` in its
 * folder on this device): shared with every member because they're files in
 * the space, and what the room agent runs with. Reads only that folder.
 */
export async function listSpaceSkillsIn(root: string): Promise<SpaceSkill[]> {
  const dir = join(root, '.claude', 'skills');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const skills: SpaceSkill[] = [];
  for (const entry of entries.sort()) {
    try {
      const { frontmatter } = parseFrontmatter(await readFile(join(dir, entry, 'SKILL.md'), 'utf8'));
      const name = frontmatter.name?.trim() || entry;
      skills.push({ cmd: `/${name}`, name, desc: frontmatter.description?.trim() ?? '' });
    } catch {
      // Not a skill folder (no SKILL.md): skip.
    }
  }
  return skills;
}

/**
 * A space the relay says is gone (410) or no longer yours (404 on its
 * roster or messages): its cached Room and comment threads are forgotten
 * (rig/docs/room-disk-cache-spec.md). Returns `result` unchanged.
 */
async function forgetIfGone<T>(bindingId: string, result: Result<T, RelayApiError>): Promise<Result<T, RelayApiError>> {
  const status = !result.success && result.error.kind === 'relay' ? result.error.status : undefined;
  if (status === 404 || status === 410) {
    // Lazy: the cache module opens the app database, which this module's tests don't have.
    await import('./local-cache-account')
      .then((m) => m.forgetLocalCaches(bindingId))
      .catch(() => undefined);
  }
  return result;
}

export const rigSpacesConnectionController = createRPCController({
  getConnectionInfo: async (): Promise<Result<SpacesConnectionInfo, RigAccountError>> => {
    const ctx = await resolveContext();
    if (isError(ctx)) return err(ctx);

    // Remembered per token (`account.ts`): opening a space asks `/v1/me` once at most.
    const who = await resolveSelfUserId();
    if (!who.success) return err(who.error);

    return ok({
      relayUrl: ctx.url,
      wsUrl: toWsUrl(ctx.url),
      selfUserId: who.data,
    });
  },

  /** The Room's own log lines (open/catch-up timings, failures) into main's log. Timings and ids only — the renderer never sends bodies or tokens. */
  log: (input: { level: 'info' | 'warn'; message: string; extra?: Record<string, unknown> }): void => {
    if (input.level === 'info') log.info(input.message, input.extra ?? {});
    else log.warn(input.message, input.extra ?? {});
  },

  /** Mints this Room's realtime credential — see this file's own header comment. Re-mint before `expiresAt`, and on every reconnect. */
  mintRealtimeTicket: async (input: {
    bindingId: string;
  }): Promise<Result<{ ticket: string; expiresAt: string }, RelayApiError>> =>
    api.mintRealtimeTicket(input.bindingId),

  listInvites: async (input: { bindingId: string }): Promise<Result<RoomInviteRow[], RelayApiError>> =>
    api.listInvites ? api.listInvites(input.bindingId) : ok([]),
  listSkills: async (input: { bindingId: string }): Promise<SpaceSkill[]> => {
    // Lazy: the rigs table module opens the app database at load, which this
    // module's other callers (and its tests) don't need.
    const { resolveLocalPathsImpl } = await import('./recent-rigs');
    const root = (await resolveLocalPathsImpl([input.bindingId]))[input.bindingId];
    return root ? listSpaceSkillsIn(root) : [];
  },
  listMembers: async (input: { bindingId: string }): Promise<Result<RoomMemberRow[], RelayApiError>> =>
    forgetIfGone(input.bindingId, await api.listMembers(input.bindingId)),

  // Connectors (connectors-spec.md): which tools the space uses. Ids only;
  // your own logins stay in main (`rpc.rig.connectors`).
  listConnectors: async (input: { bindingId: string }): Promise<Result<SpaceConnectorRow[], RelayApiError>> =>
    api.listConnectors ? api.listConnectors(input.bindingId) : ok([]),
  addConnector: async (input: { bindingId: string; connectorId: string }): Promise<Result<SpaceConnectorRow, RelayApiError>> =>
    api.addConnector
      ? api.addConnector(input.bindingId, input.connectorId)
      : err<RelayApiError>({ kind: 'relay', message: 'Connectors are not available.' }),
  removeConnector: async (input: { bindingId: string; connectorId: string }): Promise<Result<void, RelayApiError>> =>
    api.removeConnector
      ? api.removeConnector(input.bindingId, input.connectorId)
      : err<RelayApiError>({ kind: 'relay', message: 'Connectors are not available.' }),

  listMessages: async (input: {
    bindingId: string;
    /** `before` + `latest`: the scrollback page above the oldest loaded message. */
    query: { latest?: number; after?: string; before?: string };
  }): Promise<Result<RoomMessageRow[], RelayApiError>> =>
    forgetIfGone(input.bindingId, await api.listMessages(input.bindingId, input.query)),

  getSessionEvents: async (input: {
    bindingId: string;
    runId: string;
    after?: number;
  }): Promise<Result<{ run: SessionRun; events: SessionEventRow[] }, RelayApiError>> =>
    api.getSessionEvents(input.bindingId, input.runId, input.after),

  /** Your own reaction on a message, on or off (never as an agent: that's `rig_react`'s). */
  setReaction: async (input: {
    bindingId: string;
    messageId: string;
    emoji: string;
    on: boolean;
  }): Promise<Result<MessageReaction[], RelayApiError>> =>
    api.setReaction
      ? api.setReaction(input.bindingId, input.messageId, { emoji: input.emoji, on: input.on })
      : err<RelayApiError>({ kind: 'relay', message: 'Reactions are not available.' }),
  getReactions: async (input: { bindingId: string; messageId: string }): Promise<Result<MessageReaction[], RelayApiError>> =>
    api.getReactions ? api.getReactions(input.bindingId, input.messageId) : ok([]),
  listReactionsAfter: async (input: {
    bindingId: string;
    afterSeq: number;
  }): Promise<Result<Record<string, MessageReaction[]>, RelayApiError>> =>
    api.listReactionsAfter ? api.listReactionsAfter(input.bindingId, input.afterSeq) : ok({}),

  // Room themes (rig/docs/room-themes-spec.md §6). 404 reads as `{ supported: false }`.
  getThemes: async (input: {
    bindingId: string;
  }): Promise<Result<ThemesFetch<ThemesSnapshotWire>, RelayApiError>> =>
    api.getThemes ? api.getThemes(input.bindingId) : ok({ supported: false }),
  getThemeEvents: async (input: {
    bindingId: string;
    after: string;
  }): Promise<Result<ThemesFetch<ThemeEventsPage>, RelayApiError>> =>
    api.getThemeEvents
      ? api.getThemeEvents(input.bindingId, input.after)
      : ok({ supported: false }),
  setThemesEnabled: async (input: {
    bindingId: string;
    enabled: boolean;
  }): Promise<Result<ThemesFetch<{ enabled: boolean }>, RelayApiError>> =>
    api.setThemesEnabled
      ? api.setThemesEnabled(input.bindingId, input.enabled)
      : ok({ supported: false }),

  postMessage: async (input: {
    bindingId: string;
    body: string;
    kind?: string;
    meta?: Record<string, unknown>;
  }): Promise<Result<RoomMessageRow, RelayApiError>> =>
    api.postMessage(input.bindingId, { body: input.body, kind: input.kind, meta: input.meta }),

  /** See `DraftPreview`. Never fails: no account, a slow or failed call, all read as "none". */
  previewDraft: async (input: { bindingId: string; text: string }): Promise<DraftPreview> => {
    const ctx = await resolveContext();
    if (isError(ctx)) return NO_DRAFT_PREVIEW;
    try {
      const response = await fetch(
        `${ctx.url.replace(/\/+$/, '')}/v1/me/bindings/${encodeURIComponent(input.bindingId)}/draft-preview`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ctx.token}`,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text: input.text }),
          signal: AbortSignal.timeout(DRAFT_PREVIEW_TIMEOUT_MS),
        }
      );
      return response.ok ? parseDraftPreview(await response.json()) : NO_DRAFT_PREVIEW;
    } catch {
      return NO_DRAFT_PREVIEW;
    }
  },

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
