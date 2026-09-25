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
  return { kind: 'relay', message: `Could not ${action} — the relay is unreachable.` };
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

export const rigSpaceStatusController = createRPCController({
  /** `GET /v1/me/spaces/status` — every space binding the caller is a member of, with its own live/last-run status. */
  get: async (): Promise<Result<RigSpaceStatus[], RigSpaceStatusError>> => {
    const ctx = await resolveContext();
    if (isError(ctx)) return err(ctx);

    let response: Response;
    try {
      const base = ctx.url.replace(/\/+$/, '');
      response = await fetch(`${base}/v1/me/spaces/status`, {
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
      return ok(statuses);
    } catch (error) {
      return err(transportError('load your spaces’ status', error));
    }
  },
});
