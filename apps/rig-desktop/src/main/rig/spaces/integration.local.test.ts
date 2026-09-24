import { describe, expect, it } from 'vitest';
import { createHttpSpacesRelayApi } from './relay-api';
import { claimOne } from './request-claim';
import { SessionEventPublisher } from './session-publisher';

/**
 * Lane 3's live integration check (see NOTES.md for how to run it).
 *
 * Drives the ACTUAL production code — `createHttpSpacesRelayApi`,
 * `SessionEventPublisher`, `claimOne` (this file) plus `RelayRoomSource`
 * (its own `integration.local.test.ts` in the renderer) — against a REAL
 * relay: lane 1's own `startRelay()` (real Postgres, real Hocuspocus
 * realtime), started by `.spike/lane3-server.ts` in the tap-spaces
 * checkout. Skipped entirely unless `SPACES_INTEGRATION_RELAY_URL` is set,
 * so the normal suite never depends on a running relay.
 *
 * What this proves: a session run's events, published through the real
 * batching publisher, land on the relay and read back byte-for-byte
 * through the real HTTP client; two devices racing a claim over the SAME
 * relay endpoint get exactly one winner, enforced by the relay's atomic
 * `UPDATE ... WHERE status = 'queued'` — not just the in-memory fake in
 * `request-claim.test.ts`.
 */
const RELAY_URL = process.env.SPACES_INTEGRATION_RELAY_URL;
const BINDING_ID = process.env.SPACES_INTEGRATION_BINDING_ID;
const OWNER_TOKEN = process.env.SPACES_INTEGRATION_OWNER_TOKEN;
// Real, pre-minted device ids — `claim`'s `deviceId` has a foreign key into
// `binding_devices` on the relay; an ad-hoc string 500s the claim route.
const DEVICE_A_ID = process.env.SPACES_INTEGRATION_DEVICE_A_ID ?? 'device-a';
const DEVICE_B_ID = process.env.SPACES_INTEGRATION_DEVICE_B_ID ?? 'device-b';

describe.skipIf(!RELAY_URL)('spaces lane 3 — live relay integration', () => {
  if (RELAY_URL) {
    process.env.RIG_RELAY_URL = RELAY_URL;
    process.env.RIG_RELAY_TOKEN = OWNER_TOKEN;
  }
  const api = createHttpSpacesRelayApi();
  const bindingId = BINDING_ID!;

  it('publishes a session run and reads its events back through the real relay', async () => {
    const created = await api.createSession(bindingId, { agent: 'claude', title: 'Lane 3 check' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const runId = created.data.id;

    const publisher = new SessionEventPublisher({ api, bindingId, runId, maxBatchSize: 2 });
    publisher.record('tool_call', { toolCallId: 't1', title: 'Read file' });
    publisher.record('tool_call_update', { toolCallId: 't1', status: 'completed' });
    publisher.record('agent_message_chunk', { content: { type: 'text', text: 'Done.' } });
    await publisher.finish('done');

    const events = await api.getSessionEvents(bindingId, runId, 0);
    expect(events.success).toBe(true);
    if (!events.success) return;
    expect(events.data.run.status).toBe('done');
    expect(events.data.events.map((e) => e.kind)).toEqual([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]);
    // seq is exactly what the publisher assigned — proves the batching
    // split (maxBatchSize: 2) didn't reorder or duplicate anything.
    expect(events.data.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  }, 20_000);

  it('a request is claimed exactly once by two simulated devices racing the same relay row', async () => {
    const created = await api.createAgentRequest(bindingId, {
      targetOwnerUserId: process.env.SPACES_INTEGRATION_OWNER_ID!,
      targetAgent: 'claude',
      prompt: 'summarize the room',
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const request = created.data;

    const dispatchedBy: string[] = [];
    // A real dispatcher creates a real session run before patching the
    // request to 'running' — `agent_requests.run_id` has a foreign key
    // into `session_runs` on the relay (found the hard way: a fabricated
    // run id 500s the running-status patch).
    const dispatch = (deviceId: string) => async () => {
      dispatchedBy.push(deviceId);
      const run = await api.createSession(bindingId, {
        agent: 'claude',
        title: `claimed by ${deviceId}`,
      });
      if (!run.success) return { failed: true as const, reason: run.error.message };
      return { runId: run.data.id };
    };

    // Two REAL concurrent HTTP requests to the relay's claim endpoint —
    // not an in-memory race like request-claim.test.ts's fake store.
    await Promise.all([
      claimOne(api, DEVICE_A_ID, dispatch(DEVICE_A_ID), request),
      claimOne(api, DEVICE_B_ID, dispatch(DEVICE_B_ID), request),
    ]);

    expect(dispatchedBy).toHaveLength(1);

    const mine = await api.listAgentRequests('running');
    expect(mine.success).toBe(true);
    if (!mine.success) return;
    const settled = mine.data.find((r) => r.id === request.id);
    expect(settled?.status).toBe('running');
    expect(settled?.claimedByDeviceId).toEqual(expect.stringMatching(/^dev_|^device-/));
    expect(typeof settled?.runId).toBe('string');
    expect(settled?.runId?.length).toBeGreaterThan(0);
  }, 20_000);
});
