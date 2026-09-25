import { describe, expect, it } from 'vitest';
import { resolveSpaceLink } from './space-link';

const ROOT = '/Users/dylan/Rig/growth';

describe('resolveSpaceLink', () => {
  it('keeps relative links relative, tidied', () => {
    expect(resolveSpaceLink('notes/plan.md', ROOT)).toEqual({ kind: 'inside', relPath: 'notes/plan.md' });
    expect(resolveSpaceLink('./plan.md', ROOT)).toEqual({ kind: 'inside', relPath: 'plan.md' });
    expect(resolveSpaceLink('notes/../plan.md#intro', ROOT)).toEqual({ kind: 'inside', relPath: 'plan.md' });
    expect(resolveSpaceLink('launch%20notes.md', ROOT)).toEqual({ kind: 'inside', relPath: 'launch notes.md' });
    expect(resolveSpaceLink('src/app.ts:12:3', ROOT)).toEqual({ kind: 'inside', relPath: 'src/app.ts' });
  });

  it('refuses a relative link that climbs out of the space', () => {
    expect(resolveSpaceLink('../other/secret.md', ROOT)).toEqual({ kind: 'outside', path: '../other/secret.md' });
  });

  it('turns an absolute path inside the space into the relative rest', () => {
    expect(resolveSpaceLink('/Users/dylan/Rig/growth/notes/plan.md', ROOT)).toEqual({ kind: 'inside', relPath: 'notes/plan.md' });
    expect(resolveSpaceLink('/Users/dylan/Rig/growth/plan.md:40', ROOT)).toEqual({ kind: 'inside', relPath: 'plan.md' });
    // A trailing slash on the root changes nothing.
    expect(resolveSpaceLink('/Users/dylan/Rig/growth/plan.md', `${ROOT}/`)).toEqual({ kind: 'inside', relPath: 'plan.md' });
  });

  it('matches the space folder through macOS /private and case differences', () => {
    expect(resolveSpaceLink('/private/var/folders/x/growth/a.md', '/var/folders/x/growth')).toEqual({ kind: 'inside', relPath: 'a.md' });
    expect(resolveSpaceLink('/users/dylan/rig/Growth/a.md', ROOT)).toEqual({ kind: 'inside', relPath: 'a.md' });
  });

  it('opens file:// URLs inside the space', () => {
    expect(resolveSpaceLink('file:///Users/dylan/Rig/growth/notes/plan.md', ROOT)).toEqual({ kind: 'inside', relPath: 'notes/plan.md' });
    expect(resolveSpaceLink('file:///Users/dylan/Rig/growth/launch%20notes.md#top', ROOT)).toEqual({
      kind: 'inside',
      relPath: 'launch notes.md',
    });
    expect(resolveSpaceLink('file://localhost/Users/dylan/Rig/growth/a.md', ROOT)).toEqual({ kind: 'inside', relPath: 'a.md' });
  });

  it("maps a teammate's absolute path (their home, a folder named like the space) to the same file here", () => {
    expect(resolveSpaceLink('/Users/sam/Rig/growth/notes/plan.md', ROOT)).toEqual({ kind: 'inside', relPath: 'notes/plan.md' });
    expect(resolveSpaceLink('file:///home/sam/work/growth/plan.md', ROOT)).toEqual({ kind: 'inside', relPath: 'plan.md' });
  });

  it('refuses absolute paths and file:// URLs outside the space', () => {
    expect(resolveSpaceLink('/Users/dylan/.claude/CLAUDE.md', ROOT)).toEqual({ kind: 'outside', path: '/Users/dylan/.claude/CLAUDE.md' });
    // Same machine, a sibling folder: never guessed into the space.
    expect(resolveSpaceLink('/Users/dylan/Rig/other/growth/x.md', ROOT)).toEqual({ kind: 'outside', path: '/Users/dylan/Rig/other/growth/x.md' });
    expect(resolveSpaceLink('/Users/dylan/Rig/growth-old/x.md', ROOT)).toEqual({ kind: 'outside', path: '/Users/dylan/Rig/growth-old/x.md' });
    expect(resolveSpaceLink('file:///etc/hosts', ROOT)).toEqual({ kind: 'outside', path: '/etc/hosts' });
    // A teammate's file that isn't in their copy of the space.
    expect(resolveSpaceLink('/Users/sam/Downloads/plan.md', ROOT)).toEqual({ kind: 'outside', path: '/Users/sam/Downloads/plan.md' });
    // The space folder itself isn't a file.
    expect(resolveSpaceLink(ROOT, ROOT)).toEqual({ kind: 'outside', path: ROOT });
  });

  it('leaves web and mail links alone', () => {
    expect(resolveSpaceLink('https://example.com/a.md', ROOT)).toEqual({ kind: 'external' });
    expect(resolveSpaceLink('mailto:sam@example.com', ROOT)).toEqual({ kind: 'external' });
    expect(resolveSpaceLink('//cdn.example.com/x', ROOT)).toEqual({ kind: 'external' });
  });
});
