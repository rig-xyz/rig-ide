import { app } from 'electron';

/**
 * Every request the app makes to the relay goes through `fetchRelay`: it says
 * which app is asking (`x-rig-version`, `x-rig-os`) so the relay's logs can
 * be read by version, and it remembers the relay's `x-request-id` for calls
 * that fail, so an error event or a problem report can point at the exact
 * line in the relay's log. Nothing else changes: same URL, same init, same
 * Response or thrown error.
 */

export type RelayFailure = {
  /** The relay's `x-request-id`, when it answered with one. */
  reqId: string | null;
  /** HTTP status, or null when the request never got an answer (offline, timeout). */
  status: number | null;
  method: string;
  /** The path with every id or secret segment replaced by `:id` (`/v1/me/bindings/:id/manifest`). */
  route: string;
  at: number;
};

const MAX_REMEMBERED_FAILURES = 20;
/** How recent a failed call must be for its id to ride along on an error event. */
export const RELAY_FAILURE_LINK_MS = 2 * 60_000;

const failures: RelayFailure[] = [];

function appVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}

function osLabel(): string {
  const getSystemVersion = (process as { getSystemVersion?: () => string }).getSystemVersion;
  const version = typeof getSystemVersion === 'function' ? getSystemVersion() : '';
  return [process.platform, version, process.arch].filter(Boolean).join(' ');
}

/** The app's identity headers, sent on every relay call. */
export function rigClientHeaders(): Record<string, string> {
  return { 'x-rig-version': appVersion(), 'x-rig-os': osLabel() };
}

function withClientHeaders(headers: RequestInit['headers']): RequestInit['headers'] {
  const extra = rigClientHeaders();
  if (!headers) return extra;
  if (headers instanceof Headers) {
    const merged = new Headers(headers);
    for (const [key, value] of Object.entries(extra)) if (!merged.has(key)) merged.set(key, value);
    return merged;
  }
  if (Array.isArray(headers)) return [...headers, ...Object.entries(extra)];
  return { ...extra, ...headers };
}

/** `/v1/invites/tap_inv_…/accept` → `/v1/invites/:id/accept`: only plain words and `v1` survive, never ids, secrets or names. */
export function routeOf(input: string | URL): string {
  let path: string;
  try {
    path = new URL(String(input)).pathname;
  } catch {
    path = String(input).split('?')[0] ?? '';
  }
  return path
    .split('/')
    .map((segment) =>
      segment === '' || /^[a-z][a-z-]*$/.test(segment) || /^v\d+$/.test(segment) ? segment : ':id'
    )
    .join('/');
}

function remember(failure: RelayFailure): void {
  failures.push(failure);
  if (failures.length > MAX_REMEMBERED_FAILURES) failures.shift();
}

export async function fetchRelay(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  let response: Response;
  try {
    response = await fetch(input, { ...init, headers: withClientHeaders(init.headers) });
  } catch (error) {
    remember({ reqId: null, status: null, method, route: routeOf(input), at: Date.now() });
    throw error;
  }
  if (!response.ok) {
    const reqId = response.headers?.get?.('x-request-id') ?? null;
    remember({
      reqId: reqId ? reqId.slice(0, 80) : null,
      status: response.status,
      method,
      route: routeOf(input),
      at: Date.now(),
    });
  }
  return response;
}

/** The last failed relay calls, newest last (for a problem report). */
export function recentRelayFailures(): RelayFailure[] {
  return failures.map((failure) => ({ ...failure }));
}

/** The request id of the newest failed relay call within `withinMs`, if the relay gave it one. */
export function recentRelayRequestId(
  now = Date.now(),
  withinMs = RELAY_FAILURE_LINK_MS
): string | undefined {
  for (let i = failures.length - 1; i >= 0; i--) {
    const failure = failures[i]!;
    if (now - failure.at > withinMs) return undefined;
    if (failure.reqId) return failure.reqId;
  }
  return undefined;
}

/** Tests only. */
export function resetRelayFailuresForTests(): void {
  failures.length = 0;
}
