import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFileTitleCache, getFileTitle } from './file-title-cache';

describe('getFileTitle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-title-cache-'));
    clearFileTitleCache();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts the title from front-matter', async () => {
    const path = join(dir, 'doc.md');
    await writeFile(path, '---\ntitle: Positioning\n---\n\n# Something else\n', 'utf8');
    expect(await getFileTitle(path)).toBe('Positioning');
  });

  it('strips quotes around a front-matter title', async () => {
    const path = join(dir, 'doc.md');
    await writeFile(path, '---\ntitle: "Positioning"\n---\n', 'utf8');
    expect(await getFileTitle(path)).toBe('Positioning');
  });

  it('falls back to the first H1 when there is no front-matter', async () => {
    const path = join(dir, 'doc.md');
    await writeFile(path, 'Some intro text.\n\n# Real Title\n\nBody.\n', 'utf8');
    expect(await getFileTitle(path)).toBe('Real Title');
  });

  it('skips a "# " line inside a fenced code block', async () => {
    const path = join(dir, 'doc.md');
    await writeFile(path, '```bash\n# not a title\n```\n\n# Actual Title\n', 'utf8');
    expect(await getFileTitle(path)).toBe('Actual Title');
  });

  it('returns null when neither front-matter nor an H1 is present', async () => {
    const path = join(dir, 'doc.md');
    await writeFile(path, 'Just a paragraph, no heading.\n', 'utf8');
    expect(await getFileTitle(path)).toBeNull();
  });

  it('returns null for a missing file', async () => {
    expect(await getFileTitle(join(dir, 'nope.md'))).toBeNull();
  });

  it('returns a stable title across repeated calls when the file is unchanged', async () => {
    const path = join(dir, 'doc.md');
    await writeFile(path, '# First Title\n', 'utf8');
    expect(await getFileTitle(path)).toBe('First Title');
    expect(await getFileTitle(path)).toBe('First Title');
  });

  it('invalidates and re-reads once the file actually changes on disk (mtime moves forward)', async () => {
    const path = join(dir, 'doc.md');
    await writeFile(path, '# First Title\n', 'utf8');
    expect(await getFileTitle(path)).toBe('First Title');

    // A real second write, mtime included — the natural case the design
    // asks the cache to invalidate on (a save from the editor, an agent
    // rewriting the file, `git checkout`, …), as opposed to synthetically
    // forcing an identical mtime, which filesystem mtime precision makes
    // an unreliable thing to fake in a test.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(path, '# Second Title\n', 'utf8');
    expect(await getFileTitle(path)).toBe('Second Title');
  });
});
