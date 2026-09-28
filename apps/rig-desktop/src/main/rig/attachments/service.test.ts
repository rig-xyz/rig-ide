import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_MAX_BYTES, quotaCheck } from '@shared/rig/attachments';
import { ATTACHMENT_SYNC_EXCEPTIONS } from './rules';
import { createAttachmentsService, type AttachmentsDeps } from './service';
import type { ManifestSize } from './usage';

let space: string;
let outside: string;
let pastes: string;
const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function file(dir: string, name: string, content: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function service(overrides: Partial<AttachmentsDeps> & { manifest?: ManifestSize[] | null } = {}) {
  const { manifest = [], ...rest } = overrides;
  return createAttachmentsService({
    resolveSpaceRoot: async (id) => (id === 'bnd_space' ? space : null),
    role: async () => 'editor',
    fetchManifest: async () => manifest,
    pasteDir: () => pastes,
    ...rest,
  });
}

const attachments = () => (existsSync(join(space, 'attachments')) ? readdirSync(join(space, 'attachments')).sort() : []);

beforeEach(() => {
  space = temp('rig-attach-space-');
  outside = temp('rig-attach-src-');
  pastes = temp('rig-attach-paste-');
});

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('prepare: space checks', () => {
  it('blocks a space that is not linked on this computer', async () => {
    const result = await service().prepare('bnd_other', [{ source: file(outside, 'a.txt', 'a') }]);
    expect(result.space.status).toBe('notLinked');
    expect(result.space.message).toMatch(/isn’t on this computer yet/);
    expect(result.files).toEqual([]);
  });

  it('blocks viewers', async () => {
    const result = await service({ role: async () => 'viewer' }).prepare('bnd_space', [{ source: file(outside, 'a.txt', 'a') }]);
    expect(result.space.status).toBe('viewer');
    expect(result.space.message).toMatch(/Viewers can’t add files/);
  });

  it('does not block when the role cannot be read', async () => {
    const result = await service({ role: async () => null }).prepare('bnd_space', [{ source: file(outside, 'a.txt', 'a') }]);
    expect(result.space.status).toBe('ok');
  });

  it('reports usage from the relay manifest plus unsynced attachments, separately from the file checks', async () => {
    mkdirSync(join(space, 'attachments'));
    file(join(space, 'attachments'), 'pending.bin', Buffer.alloc(300));
    file(join(space, 'attachments'), 'synced.bin', Buffer.alloc(200));
    const manifest = [
      { path: 'notes.md', size: 1000 },
      { path: 'attachments/synced.bin', size: 200 },
      { path: 'folder', size: null },
    ];
    const fetchManifest = vi.fn(async () => manifest);
    const svc = service({ fetchManifest });
    const result = await svc.prepare('bnd_space', [{ source: file(outside, 'a.txt', 'hello') }]);
    // The per-file checks never wait on the relay.
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(result.space).toEqual({ status: 'ok', limitBytes: 50 * 1024 * 1024, addingBytes: 5 });
    expect(await svc.usage('bnd_space')).toEqual({ usedBytes: 1500, usageSource: 'relay', limitBytes: 50 * 1024 * 1024 });
    expect(await svc.usage('bnd_other')).toBeNull();
  });

  it("falls back to the sync daemon's state offline, and unknown usage counts as over (conservative)", async () => {
    expect(await service({ manifest: null }).usage('bnd_space')).toMatchObject({ usedBytes: null, usageSource: null });
    mkdirSync(join(space, '.rig', 'tap'), { recursive: true });
    file(space, 'notes.md', Buffer.alloc(400));
    writeFileSync(join(space, '.rig', 'tap', 'state.local.db'), JSON.stringify({ version: 1, meta: {}, paths: { 'notes.md': { lastSeenHash: 'sha256:x', localDirty: false } } }));
    expect(await service({ manifest: null }).usage('bnd_space')).toMatchObject({ usedBytes: 400, usageSource: 'local' });
  });
});

describe('quotaCheck', () => {
  it('is over when the files would cross the limit, or when usage is unknown', () => {
    expect(quotaCheck(90, 20, 100)).toEqual({ overQuota: true, message: expect.stringMatching(/over its/) });
    expect(quotaCheck(50, 20, 100)).toEqual({ overQuota: false });
    expect(quotaCheck(null, 20, 100)).toEqual({ overQuota: true, message: expect.stringMatching(/Couldn’t check/) });
    expect(quotaCheck(null, 0, 100)).toEqual({ overQuota: false });
  });
});

describe('prepare: per-file verdicts', () => {
  it('says ok for a plain file and keeps the name', async () => {
    const [v] = (await service().prepare('bnd_space', [{ source: file(outside, 'Q3 board deck.pdf', '%PDF /Type /Page') }])).files;
    expect(v).toMatchObject({ name: 'Q3 board deck.pdf', storedName: 'Q3 board deck.pdf', state: 'ok', disposition: 'copy', mime: 'application/pdf', category: 'pdf', pageCount: 1 });
  });

  it('blocks files over 25 MB', async () => {
    const big = file(outside, 'demo.mp4', '');
    truncateSync(big, ATTACHMENT_MAX_BYTES + 1);
    const result = await service().prepare('bnd_space', [{ source: big }]);
    expect(result.files[0]).toMatchObject({ state: 'blocked', problems: [{ kind: 'tooLarge' }] });
    expect(result.space.addingBytes).toBe(0);
  });

  it('blocks secrets unless the user typed Share anyway', async () => {
    const key = file(outside, 'server.pem', '-----BEGIN PRIVATE KEY-----');
    const token = file(outside, 'notes.txt', 'my token: ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    const blocked = await service().prepare('bnd_space', [{ source: key }, { source: token }]);
    expect(blocked.files.map((f) => f.state)).toEqual(['blocked', 'blocked']);
    expect(blocked.files[0]!.problems[0]!.kind).toBe('secret');
    const allowed = await service().prepare('bnd_space', [{ source: key, shareAnyway: true }]);
    expect(allowed.files[0]!.state).toBe('warn');
  });

  it('marks databases local-only', async () => {
    const [v] = (await service().prepare('bnd_space', [{ source: file(outside, 'app.sqlite', 'SQLite format 3') }])).files;
    expect(v).toMatchObject({ disposition: 'localOnly', state: 'warn', problems: [{ kind: 'localOnly' }] });
  });

  it('refuses folders and links to folders', async () => {
    const dir = join(outside, 'research');
    mkdirSync(dir);
    symlinkSync(dir, join(outside, 'research-link'));
    const result = await service().prepare('bnd_space', [{ source: dir }, { source: join(outside, 'research-link') }]);
    for (const v of result.files) expect(v).toMatchObject({ state: 'blocked', problems: [{ kind: 'folder', message: expect.stringMatching(/drop it into Files/) }] });
  });

  it('blocks a file that is gone', async () => {
    const [v] = (await service().prepare('bnd_space', [{ source: join(outside, 'nope.txt') }])).files;
    expect(v).toMatchObject({ state: 'blocked', problems: [{ kind: 'missing' }] });
  });

  it('links a file already in the space', async () => {
    mkdirSync(join(space, 'research'));
    const inside = file(join(space, 'research'), 'interviews.md', '# hi');
    const [v] = (await service().prepare('bnd_space', [{ source: inside }])).files;
    expect(v).toMatchObject({ disposition: 'link', linkPath: 'research/interviews.md', state: 'ok' });
  });

  it('previews a clash as "name (2)" (case-insensitively) and within one batch', async () => {
    mkdirSync(join(space, 'attachments'));
    file(join(space, 'attachments'), 'Whiteboard.JPG', 'old');
    const a = file(outside, 'whiteboard.jpg', 'new');
    const other = temp('rig-attach-src2-');
    const b = file(other, 'whiteboard.jpg', 'newer!');
    const result = await service().prepare('bnd_space', [{ source: a }, { source: b }]);
    expect(result.files.map((f) => f.storedName)).toEqual(['whiteboard (2).jpg', 'whiteboard (3).jpg']);
  });

  it('previews reuse when the same content is already attached', async () => {
    mkdirSync(join(space, 'attachments'));
    file(join(space, 'attachments'), 'shot.png', 'same bytes');
    const [v] = (await service().prepare('bnd_space', [{ source: file(outside, 'copy of shot.png', 'same bytes') }])).files;
    expect(v).toMatchObject({ disposition: 'reuse', linkPath: 'attachments/shot.png', storedName: 'shot.png' });
  });

  it('uses the name typed on the chip, sanitised', async () => {
    const [v] = (await service().prepare('bnd_space', [{ source: file(outside, 'a.txt', 'a'), name: 'q3/notes.txt' }])).files;
    expect(v!.name).toBe('q3_notes.txt');
  });
});

describe('commit', () => {
  it('copies into attachments/ and returns path, size, mime, hash', async () => {
    const result = await service().commit('bnd_space', [{ source: file(outside, 'Q3 deck.pdf', '%PDF-1.4') }]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0]).toMatchObject({ path: 'attachments/Q3 deck.pdf', name: 'Q3 deck.pdf', size: 8, mime: 'application/pdf', kind: 'copied' });
    expect(result.data[0]!.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readFileSync(join(space, 'attachments', 'Q3 deck.pdf'), 'utf8')).toBe('%PDF-1.4');
    // nothing left in the staging area
    expect(readdirSync(join(space, '.rig', 'attachments-staging'))).toEqual([]);
  });

  it('numbers a clash with a different file, case-insensitively', async () => {
    mkdirSync(join(space, 'attachments'));
    file(join(space, 'attachments'), 'Whiteboard.JPG', 'old');
    const result = await service().commit('bnd_space', [{ source: file(outside, 'whiteboard.jpg', 'new') }]);
    expect(result.success && result.data[0]).toMatchObject({ path: 'attachments/whiteboard (2).jpg', kind: 'copied' });
    expect(attachments()).toEqual(['Whiteboard.JPG', 'whiteboard (2).jpg']);
  });

  it('reuses the existing file when the same content was sent before', async () => {
    const svc = service();
    const first = await svc.commit('bnd_space', [{ source: file(outside, 'shot.png', 'pixels') }]);
    const again = await svc.commit('bnd_space', [{ source: file(outside, 'shot.png', 'pixels') }]);
    expect(first.success && again.success).toBe(true);
    if (!first.success || !again.success) return;
    expect(again.data[0]).toMatchObject({ path: 'attachments/shot.png', kind: 'linked', hash: first.data[0]!.hash });
    expect(attachments()).toEqual(['shot.png']);
  });

  it('links a file already in the space without copying', async () => {
    const inside = file(space, 'plan.md', '# plan');
    const result = await service().commit('bnd_space', [{ source: inside }]);
    expect(result.success && result.data[0]).toMatchObject({ path: 'plan.md', kind: 'linked', name: 'plan.md' });
    expect(attachments()).toEqual([]);
  });

  it('copies what a symlink points at, never the link', async () => {
    const target = file(outside, 'real.txt', 'real content');
    symlinkSync(target, join(outside, 'alias.txt'));
    const result = await service().commit('bnd_space', [{ source: join(outside, 'alias.txt') }]);
    expect(result.success && result.data[0]).toMatchObject({ path: 'attachments/alias.txt', kind: 'copied' });
    const stored = join(space, 'attachments', 'alias.txt');
    expect(lstatSync(stored).isSymbolicLink()).toBe(false);
    expect(readFileSync(stored, 'utf8')).toBe('real content');
  });

  it('keeps local-only files where they are', async () => {
    const db = file(outside, 'app.sqlite', 'SQLite format 3');
    const result = await service().commit('bnd_space', [{ source: db }]);
    expect(result.success && result.data[0]).toMatchObject({ kind: 'local-only', name: 'app.sqlite' });
    expect(result.success && result.data[0]!.path.endsWith('app.sqlite')).toBe(true);
    expect(attachments()).toEqual([]);
  });

  it('refuses a secret without Share anyway, copies it with', async () => {
    const key = file(outside, 'deploy.pem', '-----BEGIN PRIVATE KEY-----');
    const refused = await service().commit('bnd_space', [{ source: key }]);
    expect(refused).toMatchObject({ success: false, error: { kind: 'blocked', source: key } });
    expect(attachments()).toEqual([]);
    const shared = await service().commit('bnd_space', [{ source: key, shareAnyway: true }]);
    expect(shared.success && shared.data[0]!.kind).toBe('copied');
  });

  it('refuses viewers, unlinked spaces and going over the quota, copying nothing', async () => {
    const a = file(outside, 'a.txt', 'x'.repeat(50));
    expect(await service({ role: async () => 'viewer' }).commit('bnd_space', [{ source: a }])).toMatchObject({ success: false, error: { kind: 'viewer' } });
    expect(await service().commit('bnd_nope', [{ source: a }])).toMatchObject({ success: false, error: { kind: 'notLinked' } });
    const over = await service({ manifest: [{ path: 'x', size: 60 }], limitBytes: 100 }).commit('bnd_space', [{ source: a }]);
    expect(over).toMatchObject({ success: false, error: { kind: 'overQuota', message: expect.stringMatching(/over its/) } });
    expect(attachments()).toEqual([]);
  });

  it('refuses a folder with the board message', async () => {
    mkdirSync(join(outside, 'research'));
    const result = await service().commit('bnd_space', [{ source: join(outside, 'research') }]);
    expect(result).toMatchObject({ success: false, error: { kind: 'blocked', message: expect.stringMatching(/Folders can’t be attached yet/) } });
  });

  it('removes what it copied when a later file fails (all or nothing)', async () => {
    const ok1 = file(outside, 'one.txt', 'one');
    const locked = file(outside, 'two.txt', 'two');
    chmodSync(locked, 0o000);
    const result = await service().commit('bnd_space', [{ source: ok1 }, { source: locked }]);
    chmodSync(locked, 0o644);
    expect(result).toMatchObject({ success: false, error: { kind: 'copyFailed', source: locked } });
    expect(attachments()).toEqual([]);
  });

  it('adds the .tapignore exceptions when attaching a video, append-only and once', async () => {
    file(space, '.tapignore', '*.psd\n');
    const svc = service();
    await svc.commit('bnd_space', [{ source: file(outside, 'demo.mp4', 'video') }]);
    const after = readFileSync(join(space, '.tapignore'), 'utf8');
    expect(after.startsWith('*.psd\n')).toBe(true);
    for (const line of ATTACHMENT_SYNC_EXCEPTIONS) expect(after).toContain(line);
    await svc.commit('bnd_space', [{ source: file(outside, 'other.zip', 'zip') }]);
    expect(readFileSync(join(space, '.tapignore'), 'utf8')).toBe(after);
  });

  it('creates .tapignore for a video when there is none, and leaves it alone for other types', async () => {
    await service().commit('bnd_space', [{ source: file(outside, 'deck.pdf', 'pdf') }]);
    expect(existsSync(join(space, '.tapignore'))).toBe(false);
    await service().commit('bnd_space', [{ source: file(outside, 'clip.mov', 'mov') }]);
    expect(readFileSync(join(space, '.tapignore'), 'utf8')).toContain('!attachments/**/*.mov');
  });
});

describe('savePastedImage', () => {
  const at = new Date(2026, 8, 28, 14, 52);

  it('writes the bytes to a temp file named after the time', async () => {
    const result = await service({ now: () => at }).savePastedImage({ data: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    expect(result.success && result.data).toMatchObject({ name: 'Screenshot 14.52.png', size: 3 });
    if (!result.success) return;
    expect(result.data.path.startsWith(pastes)).toBe(true);
    expect([...readFileSync(result.data.path)]).toEqual([1, 2, 3]);
  });

  it('keeps two pastes in the same minute apart', async () => {
    const svc = service({ now: () => at });
    const a = await svc.savePastedImage({ data: new Uint8Array([1]), mime: 'image/png' });
    const b = await svc.savePastedImage({ data: new Uint8Array([2]), mime: 'image/png' });
    expect(a.success && b.success && a.data.path !== b.data.path).toBe(true);
  });

  it('refuses non-images and oversized images', async () => {
    expect(await service().savePastedImage({ data: new Uint8Array([1]), mime: 'text/plain' })).toMatchObject({ success: false, error: { kind: 'invalid' } });
    const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
    expect(await service().savePastedImage({ data: big, mime: 'image/png' })).toMatchObject({ success: false, error: { kind: 'blocked' } });
  });

  it('clears pastes older than a day', async () => {
    const old = join(pastes, 'old-paste');
    mkdirSync(old);
    const past = (at.getTime() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, past, past);
    await service({ now: () => at }).savePastedImage({ data: new Uint8Array([1]), mime: 'image/png' });
    expect(existsSync(old)).toBe(false);
  });
});
