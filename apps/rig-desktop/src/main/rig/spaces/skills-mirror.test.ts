import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSkillsMirror, isSkillsPath, mirrorSkills } from './skills-mirror';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-mirror-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, text: string, mtimeSec?: number) {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  if (mtimeSec !== undefined) await utimes(path, mtimeSec, mtimeSec);
}
const read = (rel: string) => readFile(join(root, rel), 'utf8');

describe('mirrorSkills', () => {
  it('copies a skill only Claude has to Codex, whole folder', async () => {
    await put('.claude/skills/report/SKILL.md', 'report');
    await put('.claude/skills/report/scripts/run.sh', 'echo');
    const copied = await mirrorSkills(root);
    expect(copied.sort()).toEqual([
      '.agents/skills/report/SKILL.md',
      '.agents/skills/report/scripts/run.sh',
    ]);
    expect(await read('.agents/skills/report/SKILL.md')).toBe('report');
    expect(await read('.agents/skills/report/scripts/run.sh')).toBe('echo');
  });

  it('copies a skill only Codex has to Claude', async () => {
    await put('.agents/skills/triage/SKILL.md', 'triage');
    expect(await mirrorSkills(root)).toEqual(['.claude/skills/triage/SKILL.md']);
    expect(await read('.claude/skills/triage/SKILL.md')).toBe('triage');
  });

  it('when both differ, the side with the newer file wins', async () => {
    await put('.claude/skills/report/SKILL.md', 'old', 1_000);
    await put('.agents/skills/report/SKILL.md', 'new', 2_000);
    expect(await mirrorSkills(root)).toEqual(['.claude/skills/report/SKILL.md']);
    expect(await read('.claude/skills/report/SKILL.md')).toBe('new');

    await put('.claude/skills/report/SKILL.md', 'newer', 3_000);
    expect(await mirrorSkills(root)).toEqual(['.agents/skills/report/SKILL.md']);
    expect(await read('.agents/skills/report/SKILL.md')).toBe('newer');
  });

  it('never deletes: a file only the older side has stays', async () => {
    await put('.claude/skills/report/SKILL.md', 'old', 1_000);
    await put('.claude/skills/report/notes.md', 'keep me', 1_000);
    await put('.agents/skills/report/SKILL.md', 'new', 2_000);
    await mirrorSkills(root);
    expect(await read('.claude/skills/report/SKILL.md')).toBe('new');
    expect(await read('.claude/skills/report/notes.md')).toBe('keep me');
    expect(existsSync(join(root, '.agents/skills/report/notes.md'))).toBe(false);
  });

  it('does nothing when both already match, so it settles', async () => {
    await put('.claude/skills/report/SKILL.md', 'same', 1_000);
    await put('.agents/skills/report/SKILL.md', 'same', 2_000);
    expect(await mirrorSkills(root)).toEqual([]);
    await put('.claude/skills/a/SKILL.md', 'a');
    expect(await mirrorSkills(root)).toEqual(['.agents/skills/a/SKILL.md']);
    expect(await mirrorSkills(root)).toEqual([]);
  });

  it('skips symlinked skills and symlinked files', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'skills-outside-'));
    try {
      await writeFile(join(outside, 'SKILL.md'), 'outside');
      await mkdir(join(root, '.claude/skills'), { recursive: true });
      await symlink(outside, join(root, '.claude/skills/linked'));
      await put('.claude/skills/report/SKILL.md', 'report');
      await symlink(join(outside, 'SKILL.md'), join(root, '.claude/skills/report/extra.md'));
      expect(await mirrorSkills(root)).toEqual(['.agents/skills/report/SKILL.md']);
      expect(existsSync(join(root, '.agents/skills/linked'))).toBe(false);
      expect(existsSync(join(root, '.agents/skills/report/extra.md'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('touches nothing when a skills folder is itself a link', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'skills-outside-'));
    try {
      await put('.claude/skills/report/SKILL.md', 'report');
      await mkdir(join(root, '.agents'), { recursive: true });
      await symlink(outside, join(root, '.agents/skills'));
      expect(await mirrorSkills(root)).toEqual([]);
      expect(existsSync(join(outside, 'report'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('leaves anything outside the two skills folders alone', async () => {
    await put('.claude/commands/ship.md', 'ship');
    await put('notes.md', 'notes');
    expect(await mirrorSkills(root)).toEqual([]);
    expect(existsSync(join(root, '.agents'))).toBe(false);
  });
});

describe('isSkillsPath', () => {
  it('matches the two skills folders only', () => {
    expect(isSkillsPath('.claude/skills/report/SKILL.md')).toBe(true);
    expect(isSkillsPath('.agents/skills')).toBe(true);
    expect(isSkillsPath('.claude/settings.json')).toBe(false);
    expect(isSkillsPath('docs/.claude/skills/x/SKILL.md')).toBe(false);
  });
});

describe('createSkillsMirror', () => {
  it('does nothing in a space you do not own', async () => {
    const mirror = vi.fn(async () => []);
    const watch = vi.fn(() => ({ close() {} }));
    const skills = createSkillsMirror({ isOwner: async () => false, mirror, watch });
    await skills.open('b1', root);
    expect(mirror).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  });

  it('does nothing when ownership cannot be told', async () => {
    const mirror = vi.fn(async () => []);
    const skills = createSkillsMirror({
      isOwner: async () => Promise.reject(new Error('offline')),
      mirror,
      watch: () => null,
    });
    await skills.open('b1', root);
    expect(mirror).not.toHaveBeenCalled();
  });

  it('mirrors on open for the owner and again when a skills folder changes', async () => {
    vi.useFakeTimers();
    try {
      const mirror = vi.fn(async () => []);
      let changed: ((rel: string) => void) | null = null;
      const close = vi.fn();
      const skills = createSkillsMirror({
        isOwner: async () => true,
        mirror,
        watch: (_root, onChange) => {
          changed = onChange;
          return { close };
        },
        debounceMs: 100,
      });
      await skills.open('b1', root);
      expect(mirror).toHaveBeenCalledTimes(1);
      changed!('notes.md');
      changed!('.agents/skills/x/SKILL.md');
      changed!('.agents/skills/x/SKILL.md');
      await vi.advanceTimersByTimeAsync(150);
      expect(mirror).toHaveBeenCalledTimes(2);
      // Opening again reuses the watch.
      await skills.open('b1', root);
      expect(mirror).toHaveBeenCalledTimes(3);
      skills.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching once you no longer own the space', async () => {
    let owner = true;
    const close = vi.fn();
    const skills = createSkillsMirror({
      isOwner: async () => owner,
      mirror: async () => [],
      watch: () => ({ close }),
      now: (() => {
        let t = 0;
        return () => (t += 60 * 60_000);
      })(),
    });
    await skills.open('b1', root);
    owner = false;
    await skills.open('b1', root);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('really copies between the folders on open', async () => {
    await put('.agents/skills/triage/SKILL.md', 'triage');
    const skills = createSkillsMirror({ isOwner: async () => true, watch: () => null });
    await skills.open('b1', root);
    expect(await read('.claude/skills/triage/SKILL.md')).toBe('triage');
  });
});
