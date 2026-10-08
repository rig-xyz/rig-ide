import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSkillsMirror,
  isSkillsPath,
  mirrorSkills,
  removeStaleSkills,
} from './skills-mirror';

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

const CANVAS_SKILL = [
  '---',
  'name: rig-canvas',
  'description: Build and view a local Canvas UI for this rig.',
  'allowed-tools: Bash(npx @rigxyz/canvas*), Read(.canvas/*)',
  '---',
  '',
  '# Canvas',
  '',
].join('\n');
const CANVAS_LINE =
  '- To render this rig as a local visual UI, use the `rig-canvas` skill: author `.canvas/<name>.board.toml` and run `npx @rigxyz/canvas`.';
const has = (rel: string) => existsSync(join(root, rel));

describe('removeStaleSkills', () => {
  it('removes the generated rig-canvas skill from both folders', async () => {
    await put('.claude/skills/rig-canvas/SKILL.md', CANVAS_SKILL);
    await put('.agents/skills/rig-canvas/SKILL.md', CANVAS_SKILL);
    await put('.claude/skills/report/SKILL.md', 'report');
    expect(await removeStaleSkills(root)).toEqual([
      '.claude/skills/rig-canvas',
      '.agents/skills/rig-canvas',
    ]);
    expect(has('.claude/skills/rig-canvas')).toBe(false);
    expect(has('.agents/skills/rig-canvas')).toBe(false);
    expect(await read('.claude/skills/report/SKILL.md')).toBe('report');
    expect(await removeStaleSkills(root)).toEqual([]);
  });

  it('leaves a user-authored rig-canvas skill alone', async () => {
    await put('.claude/skills/rig-canvas/SKILL.md', '---\nname: rig-canvas\ndescription: mine\n---\n');
    await put('.agents/skills/rig-canvas/SKILL.md', '# notes on @rigxyz/canvas, no frontmatter');
    expect(await removeStaleSkills(root)).toEqual([]);
    expect(has('.claude/skills/rig-canvas/SKILL.md')).toBe(true);
    expect(has('.agents/skills/rig-canvas/SKILL.md')).toBe(true);
  });

  it('leaves a linked rig-canvas skill alone', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'skills-outside-'));
    try {
      await writeFile(join(outside, 'SKILL.md'), CANVAS_SKILL);
      await mkdir(join(root, '.claude/skills'), { recursive: true });
      await symlink(outside, join(root, '.claude/skills/rig-canvas'));
      expect(await removeStaleSkills(root)).toEqual([]);
      expect(existsSync(join(outside, 'SKILL.md'))).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('removes only the generated line from the rig skill in both folders', async () => {
    const rig = `---\nname: rig\n---\n\n- \`.mcp.json\` declares servers.\n${CANVAS_LINE}\n- \`[sync]\` means live.\n`;
    const clean = '---\nname: rig\n---\n\n- `.mcp.json` declares servers.\n- `[sync]` means live.\n';
    await put('.claude/skills/rig/SKILL.md', rig, 1_000);
    await put('.agents/skills/rig/SKILL.md', rig, 1_000);
    expect(await removeStaleSkills(root)).toEqual([
      '.claude/skills/rig/SKILL.md: Canvas line',
      '.agents/skills/rig/SKILL.md: Canvas line',
    ]);
    expect(await read('.claude/skills/rig/SKILL.md')).toBe(clean);
    expect(await read('.agents/skills/rig/SKILL.md')).toBe(clean);
    expect(await mirrorSkills(root)).toEqual([]);
  });

  it('does not write the line removal through a linked rig skill', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'skills-outside-'));
    try {
      await writeFile(join(outside, 'SKILL.md'), `${CANVAS_LINE}\n`);
      await mkdir(join(root, '.claude/skills'), { recursive: true });
      await symlink(outside, join(root, '.claude/skills/rig'));
      expect(await removeStaleSkills(root)).toEqual([]);
      expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe(`${CANVAS_LINE}\n`);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('removes only the generated line from AGENTS.md and CLAUDE.md', async () => {
    await put('AGENTS.md', `# Space\n\n- one\n${CANVAS_LINE}\n- two\n`);
    await put('CLAUDE.md', `- keep\r\n${CANVAS_LINE}\r\n`);
    expect(await removeStaleSkills(root)).toEqual([
      'AGENTS.md: Canvas line',
      'CLAUDE.md: Canvas line',
    ]);
    expect(await read('AGENTS.md')).toBe('# Space\n\n- one\n- two\n');
    expect(await read('CLAUDE.md')).toBe('- keep\r\n');
    expect(await removeStaleSkills(root)).toEqual([]);
  });

  it('leaves instructions without the exact line untouched', async () => {
    const text = `- Use the rig-canvas skill sometimes.\n  ${CANVAS_LINE} (edited)\n`;
    await put('AGENTS.md', text);
    expect(await removeStaleSkills(root)).toEqual([]);
    expect(await read('AGENTS.md')).toBe(text);
  });

  it('removes the generated rig-author skill, either description', async () => {
    const author = (description: string) =>
      `---\nname: rig-author\ndescription: ${description}\nallowed-tools: Bash(rig *)\n---\n\n# Author\n`;
    await put(
      '.claude/skills/rig-author/SKILL.md',
      author('Create, package, and publish rigs. Use when building a new rig or preparing one for the hub.')
    );
    await put('.agents/skills/rig-author/SKILL.md', author('Create and package rigs. Use when building a new rig.'));
    expect(await removeStaleSkills(root)).toEqual([
      '.claude/skills/rig-author',
      '.agents/skills/rig-author',
    ]);
    expect(has('.claude/skills/rig-author')).toBe(false);
    expect(has('.agents/skills/rig-author')).toBe(false);
    expect(await removeStaleSkills(root)).toEqual([]);
  });

  it('leaves a user-authored rig-author skill alone', async () => {
    await put('.claude/skills/rig-author/SKILL.md', '---\nname: rig-author\ndescription: Our house style for docs.\n---\n');
    await put('.agents/skills/rig-author/SKILL.md', '# Create, package, and publish rigs (notes, no frontmatter)\n');
    expect(await removeStaleSkills(root)).toEqual([]);
    expect(has('.claude/skills/rig-author/SKILL.md')).toBe(true);
    expect(has('.agents/skills/rig-author/SKILL.md')).toBe(true);
  });

  it('mirrorSkills removes the generated skill instead of copying it back', async () => {
    await put('.claude/skills/rig-canvas/SKILL.md', CANVAS_SKILL);
    expect(await mirrorSkills(root)).toEqual([]);
    expect(has('.claude/skills/rig-canvas')).toBe(false);
    expect(has('.agents/skills/rig-canvas')).toBe(false);
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
