import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type {
  RigSpaceAgent,
  RigSpaceActivity,
  RigSpaceLastRun,
  RigSpaceRecentMessage,
  RigSpaceRunningItem,
  RigSpaceStatus,
  RigSpaceStatusError,
} from '@shared/rig/space-status';
import { resolveRelayUrl } from './account';
import { readRelayToken } from './config';
import { checkRelayTrust } from './relay-trust';
import { fetchRelay } from './relay-request';

/**
 * Polish round, lane C: Home's per-space live status — `GET
 * /v1/me/spaces/status` (tap `packages/relay/src/routes/space-status.ts`).
 * Account-scoped like `pulse.ts` (no workspace involved), and shares that
 * module's exact trust-then-token resolution rather than re-deriving it —
 * same reasoning as `pulse.ts`'s own header comment.
 */

const REQUEST_TIMEOUT_MS = 10_000;

type Resolved = { url: string; token: string };

const NOT_SIGNED_IN: RigSpaceStatusError = {
  kind: 'notSignedIn',
  message: 'Not signed in to Rig.',
};

async function resolveContext(): Promise<Resolved | RigSpaceStatusError> {
  const url = resolveRelayUrl();
  const trust = checkRelayTrust(url);
  if (!trust.trusted) {
    log.warn('Rig space status: refusing to send the relay token to an untrusted host', {
      host: trust.host,
    });
    return {
      kind: 'untrustedRelay',
      host: trust.host,
      message: `RIG_RELAY_URL points at an unrecognized relay (${trust.host}) — refusing to send your sign-in token there.`,
    };
  }
  const token = await readRelayToken();
  if (!token) return NOT_SIGNED_IN;
  return { url, token };
}

function isError(value: Resolved | RigSpaceStatusError): value is RigSpaceStatusError {
  return 'kind' in value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function transportError(action: string, error: unknown): RigSpaceStatusError {
  log.warn('Rig space status relay request failed', { action, error: String(error) });
  return { kind: 'relay', message: `Could not ${action}. Rig can't reach the server right now.` };
}

async function relayError(response: Response, action: string): Promise<RigSpaceStatusError> {
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    const raw = asRecord(body)?.error;
    if (typeof raw === 'string') code = raw;
  } catch {
    // non-JSON body; the status alone has to do
  }
  return {
    kind: 'relay',
    status: response.status,
    message: code
      ? `Could not ${action} (relay: ${code}).`
      : `Could not ${action} (relay ${response.status}).`,
  };
}

const AGENTS = new Set<RigSpaceAgent>(['claude', 'codex']);
const ACTIVITIES = new Set<RigSpaceActivity>([
  'thinking',
  'reading',
  'searching',
  'editing',
  'running',
  'planning',
  'waiting',
]);
const LAST_RUN_STATUSES = new Set(['done', 'stopped', 'failed']);

function toAgent(value: unknown): RigSpaceAgent {
  return typeof value === 'string' && AGENTS.has(value as RigSpaceAgent) ? (value as RigSpaceAgent) : 'claude';
}

function toRunning(value: unknown): RigSpaceRunningItem | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.runId !== 'string' || typeof raw.ownerUserId !== 'string') return null;
  const activity =
    typeof raw.activity === 'string' && ACTIVITIES.has(raw.activity as RigSpaceActivity)
      ? (raw.activity as RigSpaceActivity)
      : null;
  return {
    runId: raw.runId,
    agent: toAgent(raw.agent),
    ownerUserId: raw.ownerUserId,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    activity,
    ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
  };
}

function toLastRun(value: unknown): RigSpaceLastRun | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.ownerUserId !== 'string') return null;
  const status = typeof raw.status === 'string' && LAST_RUN_STATUSES.has(raw.status) ? raw.status : null;
  if (!status) return null;
  return {
    status: status as RigSpaceLastRun['status'],
    endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : null,
    agent: toAgent(raw.agent),
    ownerUserId: raw.ownerUserId,
  };
}

function toRecentMessage(value: unknown): RigSpaceRecentMessage | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.id !== 'string' || typeof raw.authorUserId !== 'string') return null;
  const seq = Number(raw.seq);
  if (!Number.isFinite(seq)) return null;
  return {
    id: raw.id,
    seq,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    authorUserId: raw.authorUserId,
    authorKind: raw.authorKind === 'agent' || raw.authorKind === 'guest' ? raw.authorKind : 'user',
  };
}

function toStatus(value: unknown): RigSpaceStatus | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.bindingId !== 'string') return null;
  const lastRun = toLastRun(raw.lastRun);
  return {
    bindingId: raw.bindingId,
    running: Array.isArray(raw.running)
      ? raw.running.map(toRunning).filter((r): r is RigSpaceRunningItem => r !== null)
      : [],
    ...(lastRun ? { lastRun } : {}),
    // Left absent (not `[]`) from an older relay, so Home can tell "no
    // messages" from "doesn't know" and never baselines a read marker on it.
    ...(Array.isArray(raw.recentMessages)
      ? {
          recentMessages: raw.recentMessages
            .map(toRecentMessage)
            .filter((m): m is RigSpaceRecentMessage => m !== null),
        }
      : {}),
  };
}

// ── whose agent: owners' names ("Sam's Claude finished") ──
//
// The status route names a run's owner by user id only. Home says whose
// agent it was, so names come from each space's member list — re-read at
// most every few minutes per space, or sooner (but not on every poll) when
// a run's owner isn't in the list we have: someone new.

const NAMES_TTL_MS = 5 * 60_000;
const NAMES_RETRY_MS = 60_000;
const NAMES_CONCURRENCY = 4;

export type MemberNames = ReadonlyMap<string, string>;

/** A member's display name: their profile name, else their email's local part; null when the row has neither. */
export function memberDisplayName(value: unknown): { userId: string; name: string } | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.userId !== 'string') return null;
  const name =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : typeof raw.email === 'string' && raw.email.includes('@')
        ? raw.email.split('@')[0]!
        : null;
  return name ? { userId: raw.userId, name } : null;
}

function ownerIdsOf(status: RigSpaceStatus): string[] {
  return [...status.running.map((r) => r.ownerUserId), ...(status.lastRun ? [status.lastRun.ownerUserId] : [])];
}

/** Copies each run owner's name, when known, onto the statuses. */
export function withOwnerNames(
  statuses: readonly RigSpaceStatus[],
  namesByBinding: ReadonlyMap<string, MemberNames>
): RigSpaceStatus[] {
  return statuses.map((status) => {
    const names = namesByBinding.get(status.bindingId);
    if (!names) return status;
    const named = <T extends { ownerUserId: string }>(item: T): T => {
      const ownerName = names.get(item.ownerUserId);
      return ownerName ? { ...item, ownerName } : item;
    };
    return {
      ...status,
      running: status.running.map(named),
      ...(status.lastRun ? { lastRun: named(status.lastRun) } : {}),
    };
  });
}

/** Member names per space, cached as described above. `fetchNames` answers null on any failure (the last good list, if any, stays). */
export function createOwnerNameCache(
  fetchNames: (bindingId: string) => Promise<MemberNames | null>,
  now: () => number = Date.now
): (statuses: readonly RigSpaceStatus[]) => Promise<Map<string, MemberNames>> {
  const cache = new Map<string, { at: number; names: MemberNames }>();
  return async (statuses) => {
    const due: string[] = [];
    for (const status of statuses) {
      const owners = ownerIdsOf(status);
      if (owners.length === 0) continue;
      const cached = cache.get(status.bindingId);
      const age = cached ? now() - cached.at : Infinity;
      const missing = cached ? owners.some((id) => !cached.names.has(id)) : true;
      if (age >= NAMES_TTL_MS || (missing && age >= NAMES_RETRY_MS)) due.push(status.bindingId);
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const bindingId = due[next]!;
        next += 1;
        const names = await fetchNames(bindingId);
        const previous = cache.get(bindingId);
        // A failed read still counts as a try, so a flaky relay isn't asked again every poll.
        cache.set(bindingId, { at: now(), names: names ?? previous?.names ?? new Map() });
      }
    };
    await Promise.all(Array.from({ length: Math.min(NAMES_CONCURRENCY, due.length) }, () => worker()));
    return new Map([...cache].map(([bindingId, entry]) => [bindingId, entry.names]));
  };
}

async function fetchMemberNames(ctx: Resolved, bindingId: string): Promise<MemberNames | null> {
  try {
    const base = ctx.url.replace(/\/+$/, '');
    const response = await fetchRelay(`${base}/v1/me/bindings/${encodeURIComponent(bindingId)}/members`, {
      headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const raw = asRecord(await response.json())?.members;
    if (!Array.isArray(raw)) return null;
    return new Map(
      raw.map(memberDisplayName).filter((m): m is { userId: string; name: string } => m !== null).map((m) => [m.userId, m.name])
    );
  } catch (error) {
    log.warn('Rig space status: could not load a space’s member names', { bindingId, error: String(error) });
    return null;
  }
}

let ownerNameCache: { token: string; ctx: Resolved; namesFor: ReturnType<typeof createOwnerNameCache> } | null = null;

/** The name cache for the signed-in account (a new token, e.g. another account, starts a new one). */
function ownerNamesFor(ctx: Resolved): ReturnType<typeof createOwnerNameCache> {
  if (ownerNameCache?.token !== ctx.token) {
    const entry: NonNullable<typeof ownerNameCache> = {
      token: ctx.token,
      ctx,
      namesFor: createOwnerNameCache((bindingId) => fetchMemberNames(entry.ctx, bindingId)),
    };
    ownerNameCache = entry;
  }
  ownerNameCache.ctx = ctx;
  return ownerNameCache.namesFor;
}

export const rigSpaceStatusController = createRPCController({
  /** `GET /v1/me/spaces/status` — every space binding the caller is a member of, with its own live/last-run status. */
  get: async (): Promise<Result<RigSpaceStatus[], RigSpaceStatusError>> => {
    const ctx = await resolveContext();
    if (isError(ctx)) return err(ctx);

    let response: Response;
    try {
      const base = ctx.url.replace(/\/+$/, '');
      response = await fetchRelay(`${base}/v1/me/spaces/status`, {
        headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return err(transportError('load your spaces’ status', error));
    }
    if (!response.ok) return err(await relayError(response, 'load your spaces’ status'));

    try {
      const data = asRecord(await response.json());
      const raw = data?.statuses;
      const statuses = Array.isArray(raw)
        ? raw.map(toStatus).filter((s): s is RigSpaceStatus => s !== null)
        : [];
      return ok(withOwnerNames(statuses, await ownerNamesFor(ctx)(statuses)));
    } catch (error) {
      return err(transportError('load your spaces’ status', error));
    }
  },
});
