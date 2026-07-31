import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '@main/lib/logger';

/**
 * The rig CLI's own config file — the app reads it, never writes it.
 *
 * `~/.config/rig/config.json` is where `rig login` stores the `rpat_` relay PAT.
 * Shared by the comments client (`comments.ts`) and the sign-in flow
 * (`auth.ts`), which both need to know whether the user is signed in.
 */

export function rigConfigPaths(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const paths = xdg ? [join(xdg, 'rig', 'config.json')] : [];
  paths.push(join(homedir(), '.config', 'rig', 'config.json'));
  return paths;
}

/**
 * The user's relay PAT. Read on every call rather than cached so signing in with
 * `rig login` mid-session starts working without restarting the app.
 */
export async function readRelayToken(): Promise<string | null> {
  const fromEnv = process.env.RIG_RELAY_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  for (const path of rigConfigPaths()) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) continue;
      const token = (parsed as Record<string, unknown>).relay_token;
      if (typeof token === 'string' && token.length > 0) return token;
    } catch {
      log.warn('Rig config: could not parse rig config', { path });
    }
  }
  return null;
}
