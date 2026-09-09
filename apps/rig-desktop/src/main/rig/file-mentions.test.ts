import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `recent-rigs.ts` imports `@main/db/client` at module scope, which opens a
// real (Electron-compiled) better-sqlite3 handle as a side effect of import
// — fatal under this file's plain `node` project (see that file's own test
// for the same trick). This module only ever calls `resolveLocalPathsImpl`
// through that import, so mocking the whole module — never touching the db
// at all — is enough; the walk itself is exercised against a REAL temp
// directory below.
const mocks = vi.hoisted(() => ({ resolveLocalPathsImpl: vi.fn() }));
vi.mock('./recent-rigs', () => ({ resolveLocalPathsImpl: mocks.resolveLocalPathsImpl }));

const { resolveFileMentionsImpl, resetFileMentionsCacheForTests } = await import('./file-mentions');

const BID = 'bind123';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  mocks.resolveLocalPathsImpl.mockReset();
  // Every test below reuses the same bindingId against a fresh temp dir —
  // without this, the 30s in-process cache would hand back a PREVIOUS
  // test's file list instead of walking the new directory.
  resetFileMentionsCacheForTests();
});

function makeRig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rig-file-mentions-test-'));
  dirs.push(dir);
  mocks.resolveLocalPathsImpl.mockImplementation(async (bindingIds: string[]) =>
    bindingIds.includes(BID) ? { [BID]: dir } : {}
  );
  return dir;
}

describe('resolveFileMentionsImpl', () => {
  it('resolves an exact relPath match', async () => {
    const dir = makeRig();
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'notes.md'), 'hi');

    expect(await resolveFileMentionsImpl(BID, ['docs/notes.md'])).toEqual({
      'docs/notes.md': 'docs/notes.md',
    });
  });

  it('resolves a bare basename when it is unique across the rig', async () => {
    const dir = makeRig();
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'guide.md'), 'hi');

    expect(await resolveFileMentionsImpl(BID, ['guide.md'])).toEqual({ 'guide.md': 'docs/guide.md' });
  });

  it('resolves an ambiguous basename to null', async () => {
    const dir = makeRig();
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'a', 'README.md'), 'a');
    writeFileSync(join(dir, 'b', 'README.md'), 'b');

    expect(await resolveFileMentionsImpl(BID, ['README.md'])).toEqual({ 'README.md': null });
  });

  it('resolves a candidate with no match at all to null', async () => {
    makeRig();
    expect(await resolveFileMentionsImpl(BID, ['missing.md'])).toEqual({ 'missing.md': null });
  });

  it('strips a leading "./" before matching against a real relPath', async () => {
    const dir = makeRig();
    writeFileSync(join(dir, 'notes.md'), 'hi');
    expect(await resolveFileMentionsImpl(BID, ['./notes.md'])).toEqual({ './notes.md': 'notes.md' });
  });

  it('skips ignored directories (node_modules, .git, .rig) entirely', async () => {
    const dir = makeRig();
    for (const ignored of ['node_modules', '.git', '.rig']) {
      mkdirSync(join(dir, ignored));
      writeFileSync(join(dir, ignored, 'notes.md'), 'hi');
    }
    writeFileSync(join(dir, 'real-notes.md'), 'hi');

    // The only "notes.md" reachable is the ignored copies — none of them
    // should be findable by basename, so it resolves to null rather than
    // ambiguously picking one of the ignored files.
    expect(await resolveFileMentionsImpl(BID, ['notes.md'])).toEqual({ 'notes.md': null });
    expect(await resolveFileMentionsImpl(BID, ['real-notes.md'])).toEqual({
      'real-notes.md': 'real-notes.md',
    });
  });

  it('resolves every candidate to null when the binding has no known local path', async () => {
    mocks.resolveLocalPathsImpl.mockResolvedValue({});
    expect(await resolveFileMentionsImpl(BID, ['notes.md', 'docs/guide.md'])).toEqual({
      'notes.md': null,
      'docs/guide.md': null,
    });
  });
});
