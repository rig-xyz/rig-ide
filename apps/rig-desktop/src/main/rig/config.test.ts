import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@main/lib/logger';

/**
 * `readRelayToken`'s precedence fix (the two-account bug): the config file
 * `rig login` writes must win over a stale/exported `RIG_RELAY_TOKEN`, with
 * the env var only as a fallback for when there's no signed-in account on
 * disk at all (the fresh-user harness's `--loopback` mode, CI, scripts).
 *
 * Isolated via real temp dirs for both `XDG_CONFIG_HOME` and `HOME` (the
 * latter because `rigConfigPaths()` always also checks
 * `homedir()/.config/rig/config.json`, which would otherwise pick up
 * whatever the developer running these tests happens to have signed in as
 * for real) — same approach `comments.test.ts` uses for its bound-rig
 * fixtures, rather than mocking `node:fs/promises`.
 */

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

let tempDirs: string[] = [];
let savedEnv: { XDG_CONFIG_HOME?: string; HOME?: string; RIG_RELAY_TOKEN?: string };

function makeTempConfigHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rig-config-test-')));
  tempDirs.push(dir);
  return dir;
}

function writeConfigToken(xdgHome: string, token: string): void {
  const dir = join(xdgHome, 'rig');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ relay_token: token }));
}

beforeEach(() => {
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    RIG_RELAY_TOKEN: process.env.RIG_RELAY_TOKEN,
  };
  // No config anywhere by default — an empty, isolated HOME too, so the
  // homedir()-based fallback path in `rigConfigPaths()` can never resolve to
  // a real developer config.
  process.env.XDG_CONFIG_HOME = makeTempConfigHome();
  process.env.HOME = makeTempConfigHome();
  delete process.env.RIG_RELAY_TOKEN;
  vi.mocked(log.warn).mockClear();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  vi.resetModules();
});

describe('readRelayToken precedence', () => {
  it('returns the config-file token when only the config file has one', async () => {
    writeConfigToken(process.env.XDG_CONFIG_HOME!, 'rpat_config_only');
    const { readRelayToken } = await import('./config');
    expect(await readRelayToken()).toBe('rpat_config_only');
  });

  it('falls back to RIG_RELAY_TOKEN when there is no config file at all', async () => {
    process.env.RIG_RELAY_TOKEN = 'rpat_env_only';
    const { readRelayToken } = await import('./config');
    expect(await readRelayToken()).toBe('rpat_env_only');
  });

  it('returns null when neither the config file nor the environment has a token', async () => {
    const { readRelayToken } = await import('./config');
    expect(await readRelayToken()).toBeNull();
  });

  it('the signed-in config-file account wins over a stale RIG_RELAY_TOKEN — the two-account bug', async () => {
    writeConfigToken(process.env.XDG_CONFIG_HOME!, 'rpat_signed_in_account');
    process.env.RIG_RELAY_TOKEN = 'rpat_stale_other_account';
    const { readRelayToken } = await import('./config');
    expect(await readRelayToken()).toBe('rpat_signed_in_account');
  });

  it('warns once (not per call) when the env token is ignored in favor of the config account', async () => {
    writeConfigToken(process.env.XDG_CONFIG_HOME!, 'rpat_signed_in_account');
    process.env.RIG_RELAY_TOKEN = 'rpat_stale_other_account';
    const { readRelayToken } = await import('./config');

    await readRelayToken();
    await readRelayToken();
    await readRelayToken();

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn when the env token and the config token agree', async () => {
    writeConfigToken(process.env.XDG_CONFIG_HOME!, 'rpat_same');
    process.env.RIG_RELAY_TOKEN = 'rpat_same';
    const { readRelayToken } = await import('./config');

    await readRelayToken();

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not warn when only the config file has a token (no env override in play)', async () => {
    writeConfigToken(process.env.XDG_CONFIG_HOME!, 'rpat_config_only');
    const { readRelayToken } = await import('./config');

    await readRelayToken();

    expect(log.warn).not.toHaveBeenCalled();
  });
});
