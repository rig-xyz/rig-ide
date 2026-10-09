import { describe, expect, it } from 'vitest';
import { isLockedForRole, isOwnerOnlyPath } from './owner-only';

describe('isOwnerOnlyPath', () => {
  it('matches agent instruction files at any depth, in any case', () => {
    for (const path of ['CLAUDE.md', 'AGENTS.md', 'notes/CLAUDE.md', 'a/b/agents.md', 'Claude.MD']) {
      expect(isOwnerOnlyPath(path)).toBe(true);
    }
  });

  it('matches everything under the skill, command and agent folders', () => {
    for (const path of [
      '.claude/skills/write/SKILL.md',
      '.claude/commands/ship.md',
      '.claude/agents/reviewer.md',
      '.agents/skills/x/SKILL.md',
      'sub/.claude/skills/y.md',
      '.Claude/Skills/z.md',
    ]) {
      expect(isOwnerOnlyPath(path)).toBe(true);
    }
  });

  it('leaves everything else alone', () => {
    for (const path of [
      'README.md',
      'notes/plan.md',
      'CLAUDE.md.bak',
      'my-claude.md',
      '.claude/settings.json',
      '.claude/skillsets/x.md',
      'skills/x.md',
      '.agents/notes.md',
    ]) {
      expect(isOwnerOnlyPath(path)).toBe(false);
    }
  });
});

describe('isLockedForRole', () => {
  it('locks owner-only files for a known non-owner only', () => {
    expect(isLockedForRole('editor', 'CLAUDE.md')).toBe(true);
    expect(isLockedForRole('viewer', '.claude/skills/a.md')).toBe(true);
    expect(isLockedForRole('owner', 'CLAUDE.md')).toBe(false);
    expect(isLockedForRole(null, 'CLAUDE.md')).toBe(false);
    expect(isLockedForRole(undefined, 'CLAUDE.md')).toBe(false);
    expect(isLockedForRole('editor', 'notes.md')).toBe(false);
  });
});
