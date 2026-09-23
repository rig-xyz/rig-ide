import { err, ok, type Result } from '@emdash/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigAccountError } from '@shared/rig/account';
import { isError, resolveContext } from './account';

/**
 * Spaces (lane 3): the ONE piece of relay connection info the renderer's
 * `RelayRoomSource` needs to open its own live `space:<bindingId>`
 * Hocuspocus connection and make its own HTTP catch-up calls — see that
 * module's own header comment for why the realtime/Yjs client lives in the
 * renderer (not main, unlike every other relay caller in this codebase)
 * and the tradeoff that implies for where the PAT ends up.
 *
 * Kept to exactly this one read, resolved fresh on every call (same
 * reasoning as `account.ts`'s `resolveContext`: a mid-session sign-in or
 * sign-out takes effect on the next Room open, no restart needed) — this
 * module does not itself make any relay calls or hold the realtime
 * connection.
 */

export type SpacesConnectionInfo = {
  relayUrl: string;
  wsUrl: string;
  token: string;
  selfUserId: string;
};

const REQUEST_TIMEOUT_MS = 10_000;

function toWsUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/v1/realtime';
  return url.toString();
}

export const rigSpacesConnectionController = createRPCController({
  getConnectionInfo: async (): Promise<Result<SpacesConnectionInfo, RigAccountError>> => {
    const ctx = await resolveContext();
    if (isError(ctx)) return err(ctx);

    let response: Response;
    try {
      response = await fetch(`${ctx.url.replace(/\/+$/, '')}/v1/me`, {
        headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return err<RigAccountError>({
        kind: 'relay',
        message: 'Could not connect to the relay — it may be unreachable.',
      });
    }
    if (!response.ok) {
      return err<RigAccountError>({
        kind: 'relay',
        status: response.status,
        message: `Could not load your account (relay ${response.status}).`,
      });
    }
    let userId: string | null = null;
    try {
      const data: unknown = await response.json();
      const user =
        typeof data === 'object' && data !== null
          ? (data as Record<string, unknown>).user
          : null;
      const id = typeof user === 'object' && user !== null ? (user as Record<string, unknown>).id : null;
      if (typeof id === 'string') userId = id;
    } catch {
      // handled by the null check below
    }
    if (!userId) {
      return err<RigAccountError>({ kind: 'relay', message: 'Could not load your account.' });
    }

    return ok({
      relayUrl: ctx.url,
      wsUrl: toWsUrl(ctx.url),
      token: ctx.token,
      selfUserId: userId,
    });
  },
});
