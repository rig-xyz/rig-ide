import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./account', () => ({ forgetSelfUserId: vi.fn(), resolveRelayUrl: () => 'http://127.0.0.1:4031' }));

import { devSignInTarget, writeProfileToken } from './dev-sign-in';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('devSignInTarget', () => {
  const ok = { packaged: false, relayUrl: 'http://127.0.0.1:4031', configHome: '/tmp/profile' };

  it('a dev build, a relay on this Mac, and a profile of its own', () => {
    const t = devSignInTarget(ok);
    expect(t.success && t.data.configFile).toBe('/tmp/profile/rig/config.json');
    expect(devSignInTarget({ ...ok, relayUrl: 'http://localhost:4031' }).success).toBe(true);
  });

  it('never in a packaged build, against another machine, or into ~/.config/rig', () => {
    expect(devSignInTarget({ ...ok, packaged: true }).success).toBe(false);
    expect(devSignInTarget({ ...ok, relayUrl: 'https://tap-relay.fly.dev' }).success).toBe(false);
    expect(devSignInTarget({ ...ok, configHome: undefined }).success).toBe(false);
    expect(devSignInTarget({ ...ok, configHome: '  ' }).success).toBe(false);
  });
});

describe('writeProfileToken', () => {
  it('writes the token for the owner only, keeping what else the config holds', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rig-dev-sign-in-'));
    dirs.push(home);
    const file = join(home, 'rig', 'config.json');
    mkdirSync(join(home, 'rig'));
    writeFileSync(file, JSON.stringify({ relay_token: 'rpat_old', home: '/x' }));
    await writeProfileToken(file, 'rsk_new');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ relay_token: 'rsk_new', home: '/x' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('makes the profile’s config when there is none', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rig-dev-sign-in-'));
    dirs.push(home);
    const file = join(home, 'rig', 'config.json');
    await writeProfileToken(file, 'rsk_new');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ relay_token: 'rsk_new' });
  });
});
