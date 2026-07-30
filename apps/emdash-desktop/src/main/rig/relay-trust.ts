/**
 * Trust gate for the user's global relay PAT.
 *
 * The relay URL comes from the workspace's own `.rig/tap-binding.local.json`,
 * which is repo-controlled content: a malicious checkout can point it anywhere.
 * The PAT (`rpat_`) is a global credential for the user's whole Rig account, so
 * it may only ever be attached to requests bound for a relay we trust — not to
 * whatever host the workspace happens to declare.
 *
 * Pure function, no I/O: the env value is a parameter so tests can drive it.
 */

/** The production tap relay — the one host the PAT is minted for. */
export const KNOWN_RELAY_HOST = 'tap-relay.fly.dev';

/**
 * Loopback hosts. Dev relays run here, and loopback cannot exfiltrate the
 * token off the machine, so any scheme (and any port) is allowed.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export type RelayTrust =
  | { trusted: true }
  | {
      trusted: false;
      /** The offending host (with port when present), for the UI and the log. */
      host: string;
    };

/**
 * Decides whether the signed-in user's PAT may be sent to `relayUrl`.
 *
 * Allowed:
 *   - `https:` to the known relay host (`tap-relay.fly.dev`);
 *   - any scheme to loopback (`localhost`, `127.0.0.1`, `[::1]`);
 *   - `https:` to a host listed in `RIG_RELAY_ALLOW_HOSTS` (comma-separated),
 *     for self-hosters.
 *
 * Everything else — including plain `http:` to a non-loopback host and any URL
 * that does not parse — is untrusted.
 */
export function checkRelayTrust(
  relayUrl: string,
  allowHostsEnv: string | undefined = process.env.RIG_RELAY_ALLOW_HOSTS
): RelayTrust {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return { trusted: false, host: relayUrl };
  }

  // WHATWG URL lowercases hostnames, so comparisons below are case-safe.
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) return { trusted: true };

  if (url.protocol === 'https:') {
    if (url.hostname === KNOWN_RELAY_HOST) return { trusted: true };
    const allowed = (allowHostsEnv ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0);
    if (allowed.includes(url.hostname)) return { trusted: true };
  }

  return { trusted: false, host: url.host || relayUrl };
}
