import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpPermissionRequest } from '@emdash/core/acp';
import { describe, expect, it } from 'vitest';
import { bundledSkillReadOption, isPlainViewDataPath, isRealSpaceFile, spaceReadOption, viewDataWriteOption } from './view-write';

const CWD = '/spaces/one';
const OPTIONS = [
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'no', name: 'Deny', kind: 'reject_once' },
];
const ask = (toolCall: Record<string, unknown>, options = OPTIONS): AcpPermissionRequest =>
  ({
    requestId: 'r1',
    toolCall: { id: 't', seq: 0, toolCallId: 't', title: 'Write', status: 'running', ...toolCall },
    options,
  }) as unknown as AcpPermissionRequest;
const write = (path: string) => ask({ kind: 'create-file-tool-call', path, content: '{}' });

describe('viewDataWriteOption', () => {
  it("allows, once, a write to the view's own data.json", () => {
    expect(viewDataWriteOption(write('/spaces/one/views/drafts/data.json'), CWD, 'drafts')).toBe(
      'once'
    );
    expect(viewDataWriteOption(write('views/drafts/data.json'), CWD, 'drafts')).toBe('once');
    expect(
      viewDataWriteOption(
        ask({
          kind: 'modify-file-tool-call',
          path: 'views/drafts/data.json',
          oldText: 'a',
          newText: 'b',
        }),
        CWD,
        'drafts'
      )
    ).toBe('once');
  });
  it('leaves every other write to the owner', () => {
    for (const path of [
      'views/drafts/index.html',
      'views/drafts/view.json',
      'views/feed/data.json',
      'views/drafts/../feed/data.json',
      'views/drafts/data.json/../../../AGENTS.md',
      '/spaces/two/views/drafts/data.json',
      '/etc/views/drafts/data.json',
      'data.json',
    ]) {
      expect(viewDataWriteOption(write(path), CWD, 'drafts'), path).toBeNull();
    }
  });
  it('leaves deletes, commands and tools to the owner', () => {
    const path = 'views/drafts/data.json';
    expect(
      viewDataWriteOption(ask({ kind: 'delete-file-tool-call', path }), CWD, 'drafts')
    ).toBeNull();
    expect(
      viewDataWriteOption(
        ask({ kind: 'execute-tool-call', command: `echo {} > ${path}` }),
        CWD,
        'drafts'
      )
    ).toBeNull();
    expect(
      viewDataWriteOption(ask({ kind: 'mcp-tool-call', tool: 'post', path }), CWD, 'drafts')
    ).toBeNull();
  });
  it('never picks an "always", and needs a real view name', () => {
    expect(
      viewDataWriteOption(
        ask({ kind: 'create-file-tool-call', path: 'views/drafts/data.json', content: '' }, [
          OPTIONS[0],
          OPTIONS[2],
        ]),
        CWD,
        'drafts'
      )
    ).toBeNull();
    expect(viewDataWriteOption(write('views/../data.json'), CWD, '..')).toBeNull();
  });
});

describe('isPlainViewDataPath', () => {
  it('is true for a plain file, or one not written yet', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rig-view-write-'));
    expect(await isPlainViewDataPath(cwd, 'drafts')).toBe(true);
    await mkdir(join(cwd, 'views/drafts'), { recursive: true });
    await writeFile(join(cwd, 'views/drafts/data.json'), '{}');
    expect(await isPlainViewDataPath(cwd, 'drafts')).toBe(true);
  });
  it('is false when the file or its folder is a link', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rig-view-write-'));
    await mkdir(join(cwd, 'views/drafts'), { recursive: true });
    await writeFile(join(cwd, 'secret.txt'), 'x');
    await symlink(join(cwd, 'secret.txt'), join(cwd, 'views/drafts/data.json'));
    expect(await isPlainViewDataPath(cwd, 'drafts')).toBe(false);
    await mkdir(join(cwd, 'elsewhere'));
    await symlink(join(cwd, 'elsewhere'), join(cwd, 'views/feed'));
    expect(await isPlainViewDataPath(cwd, 'feed')).toBe(false);
  });
});

describe('bundledSkillReadOption', () => {
  const read = (path: string) => ask({ kind: 'read-tool-call', path, title: `Read ${path}` });
  it('allows, once, reading a skill the app installed', () => {
    expect(
      bundledSkillReadOption(read('/Users/me/.claude/skills/rig-factory/SKILL.md'), '/Users/me')
    ).toBe('once');
    expect(
      bundledSkillReadOption(read('/Users/me/.agents/skills/rig-views/SKILL.md'), '/Users/me')
    ).toBe('once');
    expect(
      bundledSkillReadOption(read('/Users/me/.claude/skills/rig-gardener/SKILL.md'), '/Users/me')
    ).toBe('once');
  });
  it('leaves every other read, and any write there, to the owner', () => {
    for (const path of [
      '/Users/me/.claude/skills/other/SKILL.md',
      '/Users/me/.claude/skills/rig-views-evil/SKILL.md',
      '/Users/me/.claude/skills/rig-views/../../settings.json',
      '/Users/me/.claude/settings.json',
      '/Users/you/.claude/skills/rig-views/SKILL.md',
      '.claude/skills/rig-views/SKILL.md',
    ]) {
      expect(bundledSkillReadOption(read(path), '/Users/me'), path).toBeNull();
    }
    expect(
      bundledSkillReadOption(
        ask({
          kind: 'create-file-tool-call',
          path: '/Users/me/.claude/skills/rig-views/SKILL.md',
          content: '',
        }),
        '/Users/me'
      )
    ).toBeNull();
  });
});

describe('crafted read titles', () => {
  const crafted = (title: string, path: string) => ask({ kind: 'read-tool-call', path, title });
  it('refuses a title whose real target differs from the parsed path', () => {
    // The parse stops at " (", so this parses to /spaces/one/notes while the tool reads outside the space.
    const title = 'Read /spaces/one/notes (x)/../../../etc/passwd';
    expect(spaceReadOption(crafted(title, '/spaces/one/notes'), CWD)).toBeNull();
    const skill = 'Read /Users/me/.claude/skills/rig-views/a (x)/../../../../settings.json';
    expect(bundledSkillReadOption(crafted(skill, '/Users/me/.claude/skills/rig-views/a'), '/Users/me')).toBeNull();
  });
  it('still allows the tool\'s own range note', () => {
    expect(spaceReadOption(crafted('Read /spaces/one/notes/a.md (1 - 20)', '/spaces/one/notes/a.md'), CWD)).not.toBeNull();
    expect(spaceReadOption(crafted('Read /spaces/one/notes/a.md (from line 5)', '/spaces/one/notes/a.md'), CWD)).not.toBeNull();
  });
});

describe('spaceReadOption', () => {
  const read = (path: unknown, extra: Record<string, unknown> = {}) => ask({ kind: 'read-tool-call', path, title: `Read ${String(path)}`, ...extra });
  it('allows, once, a read of a file inside the space', () => {
    for (const path of ['notes/plan.md', '/spaces/one/notes/plan.md', 'views/x/index.html']) {
      expect(spaceReadOption(read(path), CWD), path).toEqual({
        optionId: 'once',
        target: join(CWD, path.replace('/spaces/one/', '')),
      });
    }
  });
  it('leaves everything else to the owner', () => {
    for (const path of ['../other/x.md', '/etc/hosts', '/spaces/two/x.md', 'notes/../../x', '.env', '.rig/state.json', 'a/.secret/b', '/spaces/one']) {
      expect(spaceReadOption(read(path), CWD), path).toBeNull();
    }
    expect(spaceReadOption(read('notes/plan.md', { resource: 'file:///x' }), CWD)).toBeNull();
    expect(spaceReadOption(read(undefined), CWD)).toBeNull();
    expect(spaceReadOption(read(''), CWD)).toBeNull();
    for (const kind of ['execute-tool-call', 'create-file-tool-call', 'modify-file-tool-call', 'delete-file-tool-call', 'search-tool-call', 'web-fetch-tool-call', 'mcp-tool-call']) {
      expect(spaceReadOption(ask({ kind, path: 'notes/plan.md' }), CWD), kind).toBeNull();
    }
    expect(spaceReadOption(read('notes/plan.md'), CWD, )).not.toBeNull();
    expect(spaceReadOption(ask({ kind: 'read-tool-call', path: 'notes/plan.md' }, [OPTIONS[0]!, OPTIONS[2]!]), CWD)).toBeNull();
  });
});

describe('isRealSpaceFile', () => {
  it('is true only for a file whose real path is inside the space', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rig-real-'));
    const space = join(root, 'space');
    const outside = join(root, 'outside');
    await mkdir(join(space, 'notes'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(space, 'notes', 'plan.md'), 'x');
    await writeFile(join(outside, 'secret.md'), 'x');
    await symlink(join(outside, 'secret.md'), join(space, 'link.md'));
    await symlink(outside, join(space, 'linked-dir'));
    expect(await isRealSpaceFile(space, join(space, 'notes', 'plan.md'))).toBe(true);
    expect(await isRealSpaceFile(space, join(space, 'link.md'))).toBe(false);
    expect(await isRealSpaceFile(space, join(space, 'linked-dir', 'secret.md'))).toBe(false);
    expect(await isRealSpaceFile(space, join(space, 'notes', 'missing.md'))).toBe(false);
  });
});
