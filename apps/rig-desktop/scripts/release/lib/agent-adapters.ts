import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The ACP adapters Rig ships for Claude and Codex are pinned in
 * `packages/plugins/package.json` and only change when we bump them. A
 * release lists the ones that have a newer version on npm, so a bump is a
 * decision rather than something nobody noticed. It never blocks a release:
 * a bump needs its own testing (codex-acp also needs its network patch
 * re-cut, see `patches/`).
 */
export const AGENT_ADAPTERS = [
  '@agentclientprotocol/claude-agent-acp',
  '@agentclientprotocol/codex-acp',
] as const;

export type AdapterStatus = { name: string; pinned: string; latest: string | null };

/** The pinned version of each adapter, read from the plugins package. */
export function pinnedAdapters(repoRoot: string): Array<{ name: string; pinned: string }> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/plugins/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return AGENT_ADAPTERS.map((name) => ({ name, pinned: pkg.dependencies?.[name] ?? 'missing' }));
}

/** True when `latest` is a newer release than `pinned` (numeric segments; anything unreadable is not newer). */
export function isNewer(latest: string, pinned: string): boolean {
  const parse = (v: string) => /^\D*(\d+(?:\.\d+)*)/.exec(v)?.[1]?.split('.').map(Number) ?? null;
  const a = parse(latest);
  const b = parse(pinned);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** The latest published version of `name`, or null when npm can't be reached. */
export async function latestOnNpm(
  name: string,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  try {
    const res = await fetchFn(`https://registry.npmjs.org/${name}/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

export async function adapterStatuses(
  repoRoot: string,
  fetchFn: typeof fetch = fetch
): Promise<AdapterStatus[]> {
  return Promise.all(
    pinnedAdapters(repoRoot).map(async ({ name, pinned }) => ({
      name,
      pinned,
      latest: await latestOnNpm(name, fetchFn),
    }))
  );
}
