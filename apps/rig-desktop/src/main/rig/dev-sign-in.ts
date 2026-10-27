import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { err, ok, type Result } from '@emdash/shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { forgetSelfUserId, resolveRelayUrl } from './account';

/**
 * Dev only: sign this profile in to a LOCAL relay as one of the local
 * database's people, from the first-run debug panel, so nobody mints tokens
 * by hand. The relay mints the session (its dev routes, loopback only, never
 * in production) and the token goes in the profile's own config. Refused in
 * a packaged build, against any relay that isn't on this machine, and
 * without a profile of its own (XDG_CONFIG_HOME): never ~/.config/rig.
 */

export type DevUser = { id: string; label: string };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Where a dev sign-in may go, or why it may not. */
export function devSignInTarget(input: {
  packaged: boolean;
  relayUrl: string;
  configHome: string | undefined;
}): Result<{ relay: URL; configFile: string }, string> {
  if (input.packaged) return err('Only in a development build.');
  let relay: URL;
  try {
    relay = new URL(input.relayUrl);
  } catch {
    return err('The relay URL is not a URL.');
  }
  if (!LOOPBACK_HOSTS.has(relay.hostname)) return err('Only against a relay on this Mac.');
  const home = input.configHome?.trim();
  if (!home) return err('Only in a profile of its own (XDG_CONFIG_HOME), never your own sign-in.');
  return ok({ relay, configFile: join(home, 'rig', 'config.json') });
}

const target = () =>
  devSignInTarget({
    packaged: app.isPackaged,
    relayUrl: resolveRelayUrl(),
    configHome: process.env.XDG_CONFIG_HOME,
  });

/** The profile's config with this token in it, keeping whatever else it holds. */
export async function writeProfileToken(configFile: string, token: string): Promise<void> {
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile, 'utf8'));
    if (parsed && typeof parsed === 'object') config = parsed as Record<string, unknown>;
  } catch {
    // None yet.
  }
  const dir = join(configFile, '..');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(configFile, JSON.stringify({ ...config, relay_token: token }, null, 2), {
    mode: 0o600,
  });
  await chmod(configFile, 0o600).catch(() => undefined);
}

export const rigDevController = createRPCController({
  /** Whether "Sign in to local relay" can be offered here, and where it would sign in. */
  available: async () => {
    const t = target();
    return t.success ? ok({ relay: t.data.relay.origin }) : err({ message: t.error });
  },
  /** The local database's people, to sign in as. */
  users: async (): Promise<Result<DevUser[], { message: string }>> => {
    const t = target();
    if (!t.success) return err({ message: t.error });
    try {
      const res = await fetch(new URL('/v1/dev/users', t.data.relay), { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return err({ message: `The local relay said ${res.status}: is it running with TAP_DEV_SIGNIN=1?` });
      const body = (await res.json()) as { users?: DevUser[] };
      return ok(body.users ?? []);
    } catch {
      return err({ message: "Can't reach the local relay." });
    }
  },
  /** Mints a session for this person on the local relay and signs this profile in with it. */
  signIn: async (input: { userId: string }): Promise<Result<{ userId: string }, { message: string }>> => {
    const t = target();
    if (!t.success) return err({ message: t.error });
    try {
      const res = await fetch(new URL('/v1/dev/sign-in', t.data.relay), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: input.userId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return err({ message: `The local relay said ${res.status}.` });
      const body = (await res.json()) as { token?: string };
      if (!body.token) return err({ message: 'The local relay sent no token.' });
      await writeProfileToken(t.data.configFile, body.token);
      forgetSelfUserId();
      return ok({ userId: input.userId });
    } catch {
      return err({ message: "Can't reach the local relay." });
    }
  },
});
