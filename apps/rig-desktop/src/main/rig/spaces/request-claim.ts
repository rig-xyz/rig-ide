import { log } from '@main/lib/logger';
import type { AgentRequest, SpacesRelayApi } from './relay-api';

/**
 * Spaces (lane 3): claims queued `agent_requests` addressed to this user and
 * hands each one to a caller-supplied dispatcher.
 *
 * Deliberately dumb about WHAT running an agent means — `dispatch` is
 * injected so this module has zero knowledge of ACP, `getAcpRuntimeClient`,
 * or headless-turn plumbing. That keeps the claim-then-advance state
 * machine (the part with a real correctness property — "exactly once,
 * even racing another device") unit-testable against a hand-written fake
 * `SpacesRelayApi`, with no runtime/Electron dependency at all.
 *
 * The claim itself is atomic SERVER-SIDE (`SPACES_NOTES.md`: `claim` is one
 * `UPDATE ... WHERE status = 'queued'`); a lost race comes back as a 409,
 * shaped here as `{kind:'relay', status:409}` by `SpacesRelayApi`. This
 * module's job is just to recognize that shape and do nothing — never
 * retry, never treat it as a transient failure.
 */

export type ClaimDispatchResult = { runId: string } | { failed: true; reason?: string };

/**
 * This device's id for a given binding (minted via the relay's device-
 * registration route, `POST /v1/me/bindings/:id/devices` — a plain string
 * is fine when every claim this poller will ever see targets one already-
 * known binding, e.g. in tests; `listAgentRequests` is cross-binding
 * ("my inbox" across every space this account owns), so the one real
 * implementation (`main/rig/spaces/dispatch.ts`) supplies a resolver that
 * mints/reuses the right device id PER request's `bindingId` — passing a
 * device id minted for the wrong binding 500s the claim route (see
 * `NOTES.md`).
 */
export type DeviceIdResolver = string | ((bindingId: string) => Promise<string>);

export type ClaimAndDispatchOptions = {
  api: SpacesRelayApi;
  deviceId: DeviceIdResolver;
  /**
   * Starts the local agent for one claimed request. Returns the new run's
   * id on success, or `{failed: true}` if the local dispatch itself could
   * not start (a bad provider, a workspace that no longer exists, etc.) —
   * distinct from a claim conflict, which never reaches this callback.
   */
  dispatch: (request: AgentRequest) => Promise<ClaimDispatchResult>;
  /**
   * Whether this computer can run `request` at all: the space's folder is
   * here and the asked agent is set up. A request this Mac can't run is
   * left queued for your other Mac rather than claimed and failed. Absent:
   * every request is claimed.
   */
  canRun?: (request: AgentRequest) => Promise<boolean>;
  /** This Mac's id among the account's computers, sent with each claim (see `claimAgentRequest`). */
  computer?: string;
};

function isConflict(error: { kind: string; status?: number }): boolean {
  return error.kind === 'relay' && error.status === 409;
}

/**
 * Lists this user's queued requests and attempts to claim + dispatch each
 * one. Requests already claimed by another device (the 409 case) are
 * skipped silently — "another device won" is the expected, common case in
 * a multi-device account, not an error.
 */
export async function claimAndDispatchQueued(options: ClaimAndDispatchOptions): Promise<void> {
  const { api, deviceId, dispatch, canRun, computer } = options;
  const queued = await api.listAgentRequests('queued');
  if (!queued.success) {
    log.warn('Rig spaces: could not list queued agent requests', {
      error: queued.error.message,
    });
    return;
  }

  for (const request of queued.data) {
    if (canRun && !(await canRun(request).catch(() => false))) {
      log.debug('Rig spaces: left a queued agent request for another computer', {
        requestId: request.id,
        bindingId: request.bindingId,
      });
      continue;
    }
    // No `await` at all on the common (plain-string) path — kept exactly as
    // synchronous as before this option grew a resolver form, so a poll's
    // very first dispatch still lands within the same microtask budget
    // existing callers (and their tests) already assume.
    if (typeof deviceId === 'string') {
      await claimOne(api, deviceId, dispatch, request, computer);
      continue;
    }
    let resolvedDeviceId: string;
    try {
      resolvedDeviceId = await deviceId(request.bindingId);
    } catch (error) {
      log.warn('Rig spaces: could not resolve a device id for a queued agent request', {
        requestId: request.id,
        bindingId: request.bindingId,
        error: String(error),
      });
      continue;
    }
    await claimOne(api, resolvedDeviceId, dispatch, request, computer);
  }
}

/**
 * Claims and dispatches exactly one request. Exported separately from
 * `claimAndDispatchQueued` so `agent_request_created` (a single stateless
 * event naming one request) doesn't have to re-list the whole queue to
 * react to it — the caller can pass a request it already has if it has one
 * (e.g. it just fetched it to get `targetAgent`/`prompt`), or fall back to
 * a fresh list-and-find.
 */
export async function claimOne(
  api: SpacesRelayApi,
  deviceId: string,
  dispatch: ClaimAndDispatchOptions['dispatch'],
  request: AgentRequest,
  computer?: string
): Promise<void> {
  const claimed = await api.claimAgentRequest(request.bindingId, request.id, deviceId, computer);
  if (!claimed.success) {
    if (isConflict(claimed.error)) {
      log.debug('Rig spaces: lost the claim race for an agent request — another device won', {
        requestId: request.id,
      });
    } else {
      log.warn('Rig spaces: could not claim an agent request', {
        requestId: request.id,
        error: claimed.error.message,
      });
    }
    return;
  }

  let result: ClaimDispatchResult;
  try {
    result = await dispatch(claimed.data);
  } catch (error) {
    result = { failed: true, reason: String(error) };
  }

  if ('failed' in result) {
    log.warn('Rig spaces: local dispatch of a claimed agent request failed', {
      requestId: request.id,
      reason: result.reason,
    });
    const patched = await api.patchAgentRequest(request.bindingId, request.id, {
      status: 'failed',
    });
    if (!patched.success) {
      log.warn('Rig spaces: could not mark a failed agent request as failed', {
        requestId: request.id,
        error: patched.error.message,
      });
    }
    // Say so in the Room: otherwise the request just vanishes.
    const agentName = request.targetAgent === 'codex' ? 'Codex' : 'Claude';
    await api
      .postMessage(request.bindingId, {
        body: `${agentName} couldn't start: ${result.reason}`,
        kind: 'system',
        meta: { event: 'agent_failed' },
      })
      .catch(() => undefined);
    return;
  }

  const running = await api.patchAgentRequest(request.bindingId, request.id, {
    status: 'running',
    runId: result.runId,
  });
  if (!running.success) {
    log.warn('Rig spaces: claimed and started a request but could not mark it running', {
      requestId: request.id,
      runId: result.runId,
      error: running.error.message,
    });
  }
}

/**
 * Advances a claimed-and-started request to its terminal status once the
 * local run ends. Kept separate from `claimOne` because the run's actual
 * end is observed later, asynchronously, by whatever is following the ACP
 * session (the session publisher's own `finish()` — see `NOTES.md`), not
 * synchronously within `dispatch()`.
 */
export async function markRequestSettled(
  api: SpacesRelayApi,
  request: Pick<AgentRequest, 'bindingId' | 'id'>,
  status: 'done' | 'failed' | 'cancelled'
): Promise<void> {
  const patched = await api.patchAgentRequest(request.bindingId, request.id, { status });
  if (!patched.success) {
    log.warn('Rig spaces: could not mark a settled agent request', {
      requestId: request.id,
      status,
      error: patched.error.message,
    });
  }
}

/**
 * Polls the queue on an interval and on demand (`checkNow`) — the two
 * triggers `NOTES.md`/the build doc call for: "on connect and on
 * `agent_request_created` events targeting this user." A poll already in
 * flight is never overlapped with another.
 */
export class RequestClaimPoller {
  private readonly options: ClaimAndDispatchOptions;
  private readonly intervalMs: number;
  private readonly scheduleInterval: (cb: () => void, ms: number) => unknown;
  private readonly cancelInterval: (handle: unknown) => void;
  private timer: unknown = null;
  private checking = false;
  /** Set while `checking` if `checkNow()` was called again mid-check, so that call isn't lost. */
  private recheckRequested = false;

  constructor(
    options: ClaimAndDispatchOptions & {
      intervalMs?: number;
      setInterval?: (cb: () => void, ms: number) => unknown;
      clearInterval?: (handle: unknown) => void;
    }
  ) {
    this.options = options;
    this.intervalMs = options.intervalMs ?? 15_000;
    this.scheduleInterval = options.setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this.cancelInterval = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.scheduleInterval(() => void this.checkNow(), this.intervalMs);
    void this.checkNow(); // also check immediately on connect
  }

  stop(): void {
    if (this.timer !== null) this.cancelInterval(this.timer);
    this.timer = null;
  }

  async checkNow(): Promise<void> {
    if (this.checking) {
      this.recheckRequested = true;
      return;
    }
    this.checking = true;
    try {
      do {
        this.recheckRequested = false;
        await claimAndDispatchQueued(this.options);
      } while (this.recheckRequested);
    } finally {
      this.checking = false;
    }
  }
}
