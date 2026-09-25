import type {
  AgentRequest,
  RelayApiError,
  RoomMemberRow,
  RoomMessageRow,
  SessionEventRow,
  SessionRun,
} from '@main/rig/spaces/relay-api';
import type { Result } from '@emdash/shared';
import { describe, expect, it } from 'vitest';
import { RelayRoomSource, type RelayRoomClient } from './relay-room-source';

/**
 * Lane 3's live integration check for `RelayRoomSource` — the renderer
 * half of `main/rig/spaces/integration.local.test.ts` (see that file's own
 * header comment, and `NOTES.md`, for how the relay under test is started:
 * a `.spike/` script in the tap-spaces checkout, real Postgres, real
 * Hocuspocus). Skipped entirely unless `SPACES_INTEGRATION_RELAY_URL` is
 * set.
 *
 * Where `relay-room-source.test.ts` proves the reducer/catch-up LOGIC
 * against a hand-written fake provider and a fake `RelayRoomClient`, this
 * proves the same class over a REAL WebSocket connection to a REAL
 * Hocuspocus room, AND the new ticket-based auth path end to end: this
 * test process has no real Electron main to proxy through, so
 * `directHttpRelayClient` below plays main's part directly (the same HTTP
 * calls `main/rig/spaces-connection.ts` would make, including minting a
 * REAL realtime ticket via `POST /v1/me/bindings/:id/realtime-ticket`) —
 * proving the wire round-trip this whole module exists for, with the
 * renderer never touching the owner's long-lived PAT for the realtime
 * connection itself.
 */
const RELAY_URL = process.env.SPACES_INTEGRATION_RELAY_URL;
const WS_URL = process.env.SPACES_INTEGRATION_WS_URL;
const BINDING_ID = process.env.SPACES_INTEGRATION_BINDING_ID;
const OWNER_TOKEN = process.env.SPACES_INTEGRATION_OWNER_TOKEN;
const OWNER_ID = process.env.SPACES_INTEGRATION_OWNER_ID;

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Stands in for main's `rig.spacesConnection` RPC surface by making the
 * SAME HTTP calls directly, PAT-authed — this test process has no real
 * Electron main process to proxy through. `mintCalls` lets the test assert
 * the ticket path was actually exercised, not silently skipped.
 */
function directHttpRelayClient(opts: { relayUrl: string; token: string }): RelayRoomClient & {
  mintCalls: number;
} {
  const base = opts.relayUrl.replace(/\/+$/, '');
  let mintCalls = 0;

  async function req(method: string, path: string, body?: unknown): Promise<Result<unknown, RelayApiError>> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      return { success: false, error: { kind: 'relay', status: response.status, message: `relay ${response.status}` } };
    }
    return { success: true, data: await response.json() };
  }

  const client: RelayRoomClient & { mintCalls: number } = {
    get mintCalls() {
      return mintCalls;
    },
    async mintRealtimeTicket(bindingId) {
      mintCalls += 1;
      const result = await req('POST', `/v1/me/bindings/${bindingId}/realtime-ticket`, {});
      if (!result.success) return result;
      const raw = result.data as { ticket?: unknown; expiresAt?: unknown };
      if (typeof raw.ticket !== 'string' || typeof raw.expiresAt !== 'string') {
        return { success: false, error: { kind: 'relay', message: 'malformed realtime-ticket response' } };
      }
      return { success: true, data: { ticket: raw.ticket, expiresAt: raw.expiresAt } };
    },
    async listMembers(bindingId) {
      const result = await req('GET', `/v1/me/bindings/${bindingId}/members`);
      if (!result.success) return result;
      const raw = (result.data as { members?: unknown }).members;
      return { success: true, data: (Array.isArray(raw) ? raw : []) as RoomMemberRow[] };
    },
    async listMessages(bindingId, query) {
      const params = new URLSearchParams();
      if (query.latest !== undefined) params.set('latest', String(query.latest));
      if (query.after !== undefined) params.set('after', query.after);
      const qs = params.toString();
      const result = await req('GET', `/v1/me/bindings/${bindingId}/messages${qs ? `?${qs}` : ''}`);
      if (!result.success) return result;
      const raw = (result.data as { messages?: unknown }).messages;
      return { success: true, data: (Array.isArray(raw) ? raw : []) as RoomMessageRow[] };
    },
    async getSessionEvents(bindingId, runId, after) {
      const q = after !== undefined ? `?after=${after}` : '';
      const result = await req('GET', `/v1/me/bindings/${bindingId}/sessions/${runId}/events${q}`);
      if (!result.success) return result;
      return { success: true, data: result.data as { run: SessionRun; events: SessionEventRow[] } };
    },
    async postMessage(bindingId, input) {
      const result = await req('POST', `/v1/me/bindings/${bindingId}/messages`, input);
      if (!result.success) return result;
      return { success: true, data: (result.data as { message: RoomMessageRow }).message };
    },
    async requestOwnAgent(bindingId, input) {
      const result = await req('POST', `/v1/me/bindings/${bindingId}/agent-requests`, input);
      if (!result.success) return result;
      return { success: true, data: (result.data as { request: AgentRequest }).request };
    },
  };
  return client;
}

describe.skipIf(!RELAY_URL)('RelayRoomSource — live relay integration', () => {
  it('opens the realtime connection with a REAL minted ticket, and a posted message round-trips through it', async () => {
    const relay = directHttpRelayClient({ relayUrl: RELAY_URL!, token: OWNER_TOKEN! });
    const source = new RelayRoomSource({
      bindingId: BINDING_ID!,
      spaceName: 'Lane 3 check',
      wsUrl: WS_URL!,
      selfUserId: OWNER_ID!,
      relay,
    });

    try {
      const seen: string[] = [];
      source.subscribe((event) => seen.push(event.type));
      source.play();
      await waitFor(() => source.isPlaying());

      // The ticket-based auth path was actually exercised, not the old
      // static-PAT-on-the-provider path — this is the whole point of the
      // relay's `POST /v1/me/bindings/:id/realtime-ticket` route.
      expect(relay.mintCalls).toBeGreaterThan(0);

      const text = `lane-3 integration check ${Date.now()}`;
      const messageId = await source.send(text);
      expect(messageId).not.toBeNull();

      await waitFor(() => source.getSnapshot().messages.some((m) => m.body === text));
      const posted = source.getSnapshot().messages.find((m) => m.body === text);
      expect(posted?.id).toBe(messageId);
      expect(seen).toContain('message_created');
    } finally {
      source.dispose();
    }
  }, 20_000);
});
