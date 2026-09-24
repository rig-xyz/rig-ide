import { describe, expect, it } from 'vitest';
import { RelayRoomSource } from './relay-room-source';

/**
 * Lane 3's live integration check for `RelayRoomSource` — the renderer
 * half of `main/rig/spaces/integration.local.test.ts` (see that file's own
 * header comment, and `NOTES.md`, for how the relay under test is started:
 * `.spike/lane3-server.ts` in the tap-spaces checkout, real Postgres, real
 * Hocuspocus). Skipped entirely unless `SPACES_INTEGRATION_RELAY_URL` is
 * set.
 *
 * Where `relay-room-source.test.ts` proves the reducer/catch-up LOGIC
 * against a hand-written fake provider and fake fetch, this proves the
 * same class over a REAL WebSocket connection to a REAL Hocuspocus room:
 * posting a message through one HTTP call is observed, via the realtime
 * notification, by a source that only ever polls its OWN local snapshot —
 * proving the wire round-trip this whole module exists for.
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

describe.skipIf(!RELAY_URL)('RelayRoomSource — live relay integration', () => {
  it('a message posted via send() round-trips through the real Hocuspocus room into the local snapshot', async () => {
    const source = new RelayRoomSource({
      bindingId: BINDING_ID!,
      spaceName: 'Lane 3 check',
      relayUrl: RELAY_URL!,
      wsUrl: WS_URL!,
      token: OWNER_TOKEN!,
      selfUserId: OWNER_ID!,
    });

    try {
      const seen: string[] = [];
      source.subscribe((event) => seen.push(event.type));
      source.play();
      await waitFor(() => source.isPlaying());

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
