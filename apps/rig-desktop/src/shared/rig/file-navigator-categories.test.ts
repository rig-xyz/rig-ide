import { describe, expect, it } from 'vitest';
import type { RigFileNode } from './files';
import { classifyEntryCategory, filterToContentOnly, relPathFromRoot } from './file-navigator-categories';

describe('classifyEntryCategory', () => {
  it('treats ordinary files and folders as content', () => {
    expect(classifyEntryCategory('positioning.md')).toBe('content');
    expect(classifyEntryCategory('notes/positioning.md')).toBe('content');
    expect(classifyEntryCategory('notes')).toBe('content');
    expect(classifyEntryCategory('src/index.ts')).toBe('content');
  });

  it('classifies AGENTS.md and CLAUDE.md as skills at any depth', () => {
    expect(classifyEntryCategory('AGENTS.md')).toBe('skills');
    expect(classifyEntryCategory('CLAUDE.md')).toBe('skills');
    expect(classifyEntryCategory('packages/api/AGENTS.md')).toBe('skills');
    expect(classifyEntryCategory('packages/api/CLAUDE.md')).toBe('skills');
  });

  it('classifies .claude/skills and .agents/skills contents as skills', () => {
    expect(classifyEntryCategory('.claude/skills/rig/SKILL.md')).toBe('skills');
    expect(classifyEntryCategory('.agents/skills/rig/SKILL.md')).toBe('skills');
    expect(classifyEntryCategory('.claude/skills')).toBe('skills');
    // nested at a non-root depth too
    expect(classifyEntryCategory('sub/.claude/skills/rig/SKILL.md')).toBe('skills');
  });

  it('classifies .claude/commands contents as skills', () => {
    expect(classifyEntryCategory('.claude/commands/ship.md')).toBe('skills');
  });

  it('classifies rig.toml, .rig/, and other dotfiles/dot-dirs as system', () => {
    expect(classifyEntryCategory('rig.toml')).toBe('system');
    expect(classifyEntryCategory('.rig')).toBe('system');
    expect(classifyEntryCategory('.rig/state.json')).toBe('system');
    expect(classifyEntryCategory('.gitignore')).toBe('system');
    expect(classifyEntryCategory('.git')).toBe('system');
    expect(classifyEntryCategory('.git/HEAD')).toBe('system');
    expect(classifyEntryCategory('.DS_Store')).toBe('system');
  });

  it('classifies non-skill contents of .claude as system, not skills', () => {
    expect(classifyEntryCategory('.claude/settings.json')).toBe('system');
    expect(classifyEntryCategory('.claude')).toBe('system');
  });
});

describe('relPathFromRoot', () => {
  it('strips the root prefix and leading slashes', () => {
    expect(relPathFromRoot('/rigs/foo', '/rigs/foo/notes/positioning.md')).toBe(
      'notes/positioning.md'
    );
    expect(relPathFromRoot('/rigs/foo', '/rigs/foo//notes/positioning.md')).toBe(
      'notes/positioning.md'
    );
  });

  it('returns the input unchanged when it does not start with root', () => {
    expect(relPathFromRoot('/rigs/foo', '/elsewhere/notes.md')).toBe('/elsewhere/notes.md');
  });
});

describe('filterToContentOnly', () => {
  const file = (relPath: string): RigFileNode => ({ name: relPath.split('/').pop() ?? relPath, relPath, kind: 'file' });
  const dir = (relPath: string, children: RigFileNode[]): RigFileNode => ({
    name: relPath.split('/').pop() ?? relPath,
    relPath,
    kind: 'dir',
    children,
  });

  it('drops system and skills entries regardless of nesting, keeping content untouched', () => {
    const tree = [
      file('notes.md'),
      file('rig.toml'),
      file('AGENTS.md'),
      dir('.rig', [file('.rig/state.json')]),
      dir('.claude', [dir('skills', [file('.claude/skills/rig/SKILL.md')])]),
    ];
    expect(filterToContentOnly(tree)).toEqual([file('notes.md')]);
  });

  it('keeps a folder that mixes content and system/skills children, pruned to content only', () => {
    const tree = [dir('docs', [file('docs/readme.md'), file('docs/.DS_Store')])];
    expect(filterToContentOnly(tree)).toEqual([dir('docs', [file('docs/readme.md')])]);
  });

  it('a system file that is itself a directory (like .rig) never survives, even when it holds content-looking names', () => {
    const tree = [dir('.rig', [file('.rig/notes.md')])];
    expect(filterToContentOnly(tree)).toEqual([]);
  });
});
