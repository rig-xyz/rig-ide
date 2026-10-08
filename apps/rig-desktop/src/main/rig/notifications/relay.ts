import { err, ok, type Result } from '@emdash/shared';
import type { RigAccountError } from '@shared/rig/account';
import type {
  NotificationLevel,
  NotificationTier,
  NotificationType,
  RigNotification,
  RigNotificationSpaceSummary,
  RigNotificationSummary,
} from '@shared/rig/notifications';
import { log } from '@main/lib/logger';
import { isError, resolveContext } from '../account';
import { fetchRelay } from '../relay-request';

/**
 * The relay's notification routes (tap `packages/relay/src/routes/
 * notifications.ts`). Account-scoped like `space-status.ts`, with the same
 * trust-then-token resolution (`resolveContext`): the token never goes to
 * an unrecognized relay. Every parse is defensive; a malformed row is
 * dropped, never trusted.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export type NotificationsRelayError = RigAccountError | { kind: 'relay'; status?: number; message: string };

const TYPES = new Set<NotificationType>([
  'mention',
  'reply',
  'message',
  'comment',
  'agent_finished',
  'agent_waiting',
  'agent_request',
  'invite',
  'reaction',
]);
const LEVELS = new Set<NotificationLevel>(['all', 'mentions', 'nothing']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function toNotification(value: unknown): RigNotification | null {
  const r = asRecord(value);
  if (!r || typeof r.id !== 'string' || typeof r.title !== 'string' || typeof r.createdAt !== 'string') return null;
  if (typeof r.type !== 'string' || !TYPES.has(r.type as NotificationType)) return null;
  const tier: NotificationTier = r.tier === 'direct' ? 'direct' : 'ambient';
  const actor = asRecord(r.actor) ?? {};
  const kind = actor.kind === 'agent' || actor.kind === 'guest' ? actor.kind : 'user';
  const agent = actor.agent === 'claude' || actor.agent === 'codex' ? actor.agent : null;
  return {
    id: r.id,
    type: r.type as NotificationType,
    tier,
    bindingId: str(r.bindingId),
    spaceName: str(r.spaceName),
    actor: { kind, userId: str(actor.userId), name: str(actor.name), agent },
    messageId: str(r.messageId),
    messageSeq: typeof r.messageSeq === 'number' ? r.messageSeq : null,
    runId: str(r.runId),
    requestId: str(r.requestId),
    inviteId: str(r.inviteId),
    path: str(r.path),
    ...(typeof r.fileAuthorUserId === 'string' ? { fileAuthorUserId: r.fileAuthorUserId } : {}),
    title: r.title,
    body: typeof r.body === 'string' ? r.body : '',
    createdAt: r.createdAt,
    readAt: str(r.readAt),
  };
}

export function toSummary(value: unknown): RigNotificationSummary {
  const r = asRecord(value) ?? {};
  const spaces: RigNotificationSpaceSummary[] = [];
  for (const raw of Array.isArray(r.spaces) ? r.spaces : []) {
    const s = asRecord(raw);
    if (!s || typeof s.bindingId !== 'string') continue;
    const latest = asRecord(s.latestDirect);
    const latestActor = asRecord(latest?.actor) ?? {};
    spaces.push({
      bindingId: s.bindingId,
      name: str(s.name),
      latestDirect:
        latest && typeof latest.type === 'string' && TYPES.has(latest.type as NotificationType)
          ? {
              type: latest.type as NotificationType,
              actor: {
                kind: latestActor.kind === 'agent' || latestActor.kind === 'guest' ? latestActor.kind : 'user',
                userId: null,
                name: str(latestActor.name),
                agent: latestActor.agent === 'claude' || latestActor.agent === 'codex' ? latestActor.agent : null,
              },
            }
          : null,
      level: typeof s.level === 'string' && LEVELS.has(s.level as NotificationLevel) ? (s.level as NotificationLevel) : 'all',
      lastReadSeq: num(s.lastReadSeq),
      spaceUnread: num(s.spaceUnread),
      directUnread: num(s.directUnread),
      directUnreadNoMessage: num(s.directUnreadNoMessage),
    });
  }
  return { spaces, invitesUnread: num(r.invitesUnread), directUnreadTotal: num(r.directUnreadTotal) };
}

export type RelayContext = { url: string; token: string };

export async function relayContext(): Promise<Result<RelayContext, NotificationsRelayError>> {
  const ctx = await resolveContext();
  return isError(ctx) ? err(ctx) : ok(ctx);
}

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  action: string,
  body?: unknown
): Promise<Result<unknown, NotificationsRelayError>> {
  const ctx = await relayContext();
  if (!ctx.success) return ctx;
  let response: Response;
  try {
    response = await fetchRelay(new URL(path, ctx.data.url), {
      method,
      headers: {
        authorization: `Bearer ${ctx.data.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn('notifications: relay request failed', { action, error: String(error) });
    return err({ kind: 'relay', message: `Could not ${action}. Rig can't reach the server right now.` });
  }
  if (!response.ok) {
    let code: string | null = null;
    try {
      code = str(asRecord(await response.json())?.error);
    } catch {
      // non-JSON body
    }
    return err({
      kind: 'relay',
      status: response.status,
      message: code ? `Could not ${action} (relay: ${code}).` : `Could not ${action} (relay ${response.status}).`,
    });
  }
  try {
    return ok(await response.json());
  } catch {
    return err({ kind: 'relay', status: response.status, message: `Could not ${action}: unreadable reply.` });
  }
}

export type ListQuery = {
  after?: string;
  before?: string;
  limit?: number;
  tier?: NotificationTier;
  unreadOnly?: boolean;
  /** Only this Space's rows (a relay from before the param ignores it, or rejects it with a 400). */
  bindingId?: string;
};

export async function listNotifications(q: ListQuery): Promise<Result<RigNotification[], NotificationsRelayError>> {
  const params = new URLSearchParams();
  if (q.after) params.set('after', q.after);
  if (q.before) params.set('before', q.before);
  if (q.limit) params.set('limit', String(q.limit));
  if (q.tier) params.set('tier', q.tier);
  if (q.unreadOnly) params.set('unreadOnly', '1');
  if (q.bindingId) params.set('bindingId', q.bindingId);
  const res = await call('GET', `/v1/me/notifications?${params.toString()}`, 'load notifications');
  if (!res.success) return res;
  const rows = asRecord(res.data)?.notifications;
  return ok((Array.isArray(rows) ? rows : []).map(toNotification).filter((n): n is RigNotification => n !== null));
}

export async function fetchSummary(): Promise<Result<RigNotificationSummary, NotificationsRelayError>> {
  const res = await call('GET', '/v1/me/notifications/summary', 'load unread counts');
  return res.success ? ok(toSummary(res.data)) : res;
}

export async function markRead(input: { ids: string[] } | { all: true }): Promise<Result<void, NotificationsRelayError>> {
  const res = await call('POST', '/v1/me/notifications/read', 'mark notifications read', input);
  return res.success ? ok(undefined) : res;
}

export async function markSpaceRead(
  bindingId: string,
  input: { seq?: number; seen?: boolean }
): Promise<Result<void, NotificationsRelayError>> {
  const res = await call('POST', `/v1/me/spaces/${encodeURIComponent(bindingId)}/read`, 'mark the space read', input);
  return res.success ? ok(undefined) : res;
}

export async function getLevel(bindingId: string): Promise<Result<NotificationLevel, NotificationsRelayError>> {
  const res = await call('GET', `/v1/me/spaces/${encodeURIComponent(bindingId)}/notification-level`, 'load the space level');
  if (!res.success) return res;
  const level = asRecord(res.data)?.level;
  return ok(typeof level === 'string' && LEVELS.has(level as NotificationLevel) ? (level as NotificationLevel) : 'all');
}

export async function setLevel(
  bindingId: string,
  level: NotificationLevel
): Promise<Result<NotificationLevel, NotificationsRelayError>> {
  const res = await call(
    'PATCH',
    `/v1/me/spaces/${encodeURIComponent(bindingId)}/notification-level`,
    'change the space level',
    { level }
  );
  return res.success ? ok(level) : res;
}
