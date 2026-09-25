import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RigCommentMessage } from '@shared/rig/comments';
import { anchorFor, createRigTools, runRigTool, type RigTool, type RigToolScope, type RigToolsBackend } from './rig-tools';

const SCOPE: RigToolScope = { bindingId: 'b1', ownerUserId: 'u-dylan', agent: 'claude', cwd: '/rigs/space' };
const NOW = Date.parse('2026-09-25T12:00:00Z');

function comment(over: Partial<RigCommentMessage> & { id: string }): RigCommentMessage {
  return {
    seq: '1',
    bindingId: 'b1',
    author: { userId: 'u-sam', name: 'Sam', avatarUrl: null, kind: 'user' },
    kind: 'comment',
    body: 'Hello',
    parentId: null,
    intentId: null,
    path: 'notes/plan.md',
    meta: null,
    anchor: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2026-09-25T10:00:00Z',
    editedAt: null,
    deletedAt: null,
    ...over,
  };
}

function fakeBackend(over: Partial<RigToolsBackend> = {}): RigToolsBackend {
  return {
    whoami: vi.fn(async () => ok({ id: 'u-dylan' })),
    bindingAt: vi.fn((dir: string) => (dir.startsWith('/rigs/space') ? 'b1' : null)),
    createInvite: vi.fn(async (_root, email, role) =>
      ok({
        invite: {
          id: 'inv1',
          emailConstraint: email,
          role,
          maxUses: 1,
          useCount: 0,
          expiresAt: null,
          revokedAt: null,
          label: null,
          createdAt: '2026-09-25T12:00:00Z',
        },
        url: 'https://userig.xyz/join/secret',
        email: { sent: true, to: email, reason: null },
      })
    ),
    listMembers: vi.fn(async () =>
      ok([
        { userId: 'u-dylan', clerkUserId: 'c1', name: 'Dylan', email: 'dylan@rig.xyz', role: 'owner', avatarUrl: null },
        { userId: 'u-sam', clerkUserId: 'c2', name: 'Sam', email: 'sam@rig.xyz', role: 'editor', avatarUrl: null },
      ])
    ),
    listInvites: vi.fn(async () =>
      ok([
        { id: 'i1', inviterUserId: 'u-dylan', email: 'hugo@acme.co', role: 'viewer', revoked: false },
        { id: 'i2', inviterUserId: 'u-dylan', email: 'old@acme.co', role: 'editor', revoked: true },
        { id: 'i3', inviterUserId: 'u-dylan', email: 'SAM@rig.xyz', role: 'editor', revoked: false },
      ])
    ),
    listFiles: vi.fn(async () =>
      ok([
        { name: 'plan.md', relPath: 'plan.md', kind: 'file' as const, mtimeMs: NOW - 5 * 60_000 },
        {
          name: 'notes',
          relPath: 'notes',
          kind: 'dir' as const,
          children: [
            { name: 'old.md', relPath: 'notes/old.md', kind: 'file' as const, mtimeMs: NOW - 3 * 24 * 3_600_000 },
            { name: 'call.md', relPath: 'notes/call.md', kind: 'file' as const, mtimeMs: NOW - 2 * 3_600_000 },
          ],
        },
      ])
    ),
    spaceStory: vi.fn(async () => "Sam's Claude drafted the launch plan."),
    listComments: vi.fn(async () =>
      ok([
        comment({ id: 'm1', body: 'Is this date right?', anchor: { exact: 'ship on Oct 3' } }),
        comment({
          id: 'm2',
          parentId: 'm1',
          path: null,
          body: 'Yes, confirmed.',
          author: { userId: 'u-dylan', name: 'Dylan', avatarUrl: null, kind: 'agent' },
          meta: { agent: 'codex' },
        }),
        comment({ id: 'm3', body: 'Old nit', resolvedAt: '2026-09-24T00:00:00Z' }),
      ])
    ),
    readText: vi.fn(async () => '# Plan\n\nWe ship on Oct 3 after the review.\n'),
    createComment: vi.fn(async () => ok(comment({ id: 'm9' }))),
    replyComment: vi.fn(async () => ok(comment({ id: 'm10', parentId: 'm1' }))),
    ...over,
  };
}

function tool(backend: RigToolsBackend, name: string): RigTool {
  return createRigTools(backend, () => NOW).find((t) => t.name === name)!;
}

async function call(backend: RigToolsBackend, name: string, input: Record<string, unknown> = {}) {
  return runRigTool(backend, tool(backend, name), SCOPE, input);
}

describe('rig tools', () => {
  it('are the five tools, each saying when to use it', () => {
    const tools = createRigTools(fakeBackend());
    expect(tools.map((t) => t.name)).toEqual([
      'rig_invite',
      'rig_people',
      'rig_recent_changes',
      'rig_file_comments',
      'rig_comment',
    ]);
    for (const t of tools) expect(t.description).toMatch(/Use it when|Use it whenever/);
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      'rig_people',
      'rig_recent_changes',
      'rig_file_comments',
    ]);
  });

  it('refuse to act once the device is signed in as someone else', async () => {
    const backend = fakeBackend({ whoami: async () => ok({ id: 'u-other' }) });
    const result = await call(backend, 'rig_invite', { email: 'hugo@acme.co' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('signed in to rig as someone else');
    expect(backend.createInvite).not.toHaveBeenCalled();
  });

  it('refuse when who is signed in cannot be checked', async () => {
    const backend = fakeBackend({ whoami: async () => err({ message: 'Your sign-in has expired.' }) });
    const result = await call(backend, 'rig_people');
    expect(result).toEqual({ text: "Couldn't check who's signed in to rig: Your sign-in has expired.", isError: true });
    expect(backend.listMembers).not.toHaveBeenCalled();
  });

  it('turn a throwing backend into an error result', async () => {
    const backend = fakeBackend({
      listMembers: async () => {
        throw new Error('boom');
      },
    });
    expect(await call(backend, 'rig_people')).toEqual({ text: 'rig_people failed: boom', isError: true });
  });
});

describe('rig_invite', () => {
  it("invites through the space's folder, as editor by default, and returns the link", async () => {
    const backend = fakeBackend();
    const result = await call(backend, 'rig_invite', { email: ' hugo@acme.co ' });
    expect(backend.createInvite).toHaveBeenCalledWith('/rigs/space', 'hugo@acme.co', 'editor');
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('Invited hugo@acme.co to this space as editor.');
    expect(result.text).toContain('Invite email sent to hugo@acme.co.');
    expect(result.text).toContain('https://userig.xyz/join/secret');
  });

  it('says when no email went out', async () => {
    const backend = fakeBackend({
      createInvite: async (_root, email, role) =>
        ok({
          invite: { id: 'i', emailConstraint: email, role, maxUses: 1, useCount: 0, expiresAt: null, revokedAt: null, label: null, createdAt: '' },
          url: 'https://userig.xyz/join/s',
          email: { sent: false, to: null, reason: 'email_not_configured' },
        }),
    });
    const result = await call(backend, 'rig_invite', { email: 'hugo@acme.co', role: 'viewer' });
    expect(result.text).toContain('as viewer');
    expect(result.text).toContain('No invite email went out (email_not_configured)');
  });

  it("passes on the relay's refusal", async () => {
    const backend = fakeBackend({ createInvite: async () => err({ message: "You don't have permission." }) });
    const result = await call(backend, 'rig_invite', { email: 'hugo@acme.co' });
    expect(result).toEqual({ text: "Couldn't invite hugo@acme.co: You don't have permission.", isError: true });
  });

  it("refuses a non-email, and a folder that isn't this space's any more", async () => {
    const backend = fakeBackend();
    expect((await call(backend, 'rig_invite', { email: 'hugo' })).isError).toBe(true);
    const moved = fakeBackend({ bindingAt: () => 'b-other' });
    expect((await call(moved, 'rig_invite', { email: 'hugo@acme.co' })).isError).toBe(true);
    expect(backend.createInvite).not.toHaveBeenCalled();
    expect(moved.createInvite).not.toHaveBeenCalled();
  });
});

describe('rig_people', () => {
  it('lists members and the invites still pending', async () => {
    const backend = fakeBackend();
    const { text } = await call(backend, 'rig_people');
    expect(backend.listMembers).toHaveBeenCalledWith('b1');
    expect(text).toContain('Members (2):');
    expect(text).toContain('- Dylan <dylan@rig.xyz>: owner (your owner)');
    expect(text).toContain('- Sam <sam@rig.xyz>: editor');
    // Revoked, and already joined (Sam), are left out.
    expect(text).toContain('Pending invites (1):\n- hugo@acme.co: viewer');
    expect(text).not.toContain('old@acme.co');
  });

  it("still lists members when invites can't load", async () => {
    const backend = fakeBackend({ listInvites: async () => err({ message: 'forbidden' }) });
    const result = await call(backend, 'rig_people');
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Pending invites: couldn't load them (forbidden).");
  });
});

describe('rig_recent_changes', () => {
  it("lists the space's changed files newest first, with Pulse's story", async () => {
    const backend = fakeBackend();
    const { text } = await call(backend, 'rig_recent_changes');
    expect(backend.listFiles).toHaveBeenCalledWith('/rigs/space');
    expect(backend.spaceStory).toHaveBeenCalledWith('b1');
    expect(text).toBe(
      [
        "Summary: Sam's Claude drafted the launch plan.",
        '',
        '2 files changed in the last 24 h, newest first:',
        '- plan.md (5 min ago)',
        '- notes/call.md (2 h ago)',
      ].join('\n')
    );
  });

  it('looks further back when asked, and works without a story', async () => {
    const backend = fakeBackend({ spaceStory: async () => null });
    const { text } = await call(backend, 'rig_recent_changes', { hours: 96 });
    expect(text).toContain('3 files changed in the last 96 h');
    expect(text).toContain('- notes/old.md (3 d ago)');
    expect(text).not.toContain('Summary');
  });

  it('says so when nothing changed', async () => {
    const backend = fakeBackend({ listFiles: async () => ok([]), spaceStory: async () => null });
    expect((await call(backend, 'rig_recent_changes')).text).toBe('No files changed in the last 24 h.');
  });
});

describe('rig_file_comments', () => {
  it("reads a file's open threads with their ids, quotes, and who said what", async () => {
    const backend = fakeBackend();
    const { text } = await call(backend, 'rig_file_comments', { path: 'notes/plan.md' });
    expect(backend.listComments).toHaveBeenCalledWith('/rigs/space/notes/plan.md');
    expect(text).toBe(
      [
        '1 thread on notes/plan.md:',
        '',
        'Thread m1 on “ship on Oct 3”',
        '- Sam: Is this date right?',
        "  - Dylan's agent (codex): Yes, confirmed.",
      ].join('\n')
    );
  });

  it('includes resolved threads when asked', async () => {
    const { text } = await call(fakeBackend(), 'rig_file_comments', { path: 'notes/plan.md', include_resolved: true });
    expect(text).toContain('Thread m3 (resolved)');
  });

  it('never reads outside the space, or from a different rig nested in it', async () => {
    const backend = fakeBackend({ bindingAt: (dir) => (dir === '/rigs/space/vendor' ? 'b-nested' : 'b1') });
    for (const path of ['../other/plan.md', '/etc/passwd', '', 'vendor/readme.md']) {
      expect((await call(backend, 'rig_file_comments', { path })).isError).toBe(true);
    }
    expect(backend.listComments).not.toHaveBeenCalled();
  });
});

describe('rig_comment', () => {
  it('pins a new comment to the quoted passage, as the agent', async () => {
    const backend = fakeBackend();
    const result = await call(backend, 'rig_comment', { path: 'notes/plan.md', body: 'Confirm with legal', quote: 'ship on Oct 3' });
    expect(result.text).toBe('Commented on notes/plan.md (thread m9).');
    expect(backend.readText).toHaveBeenCalledWith('/rigs/space', 'notes/plan.md');
    expect(backend.createComment).toHaveBeenCalledWith({
      absPath: '/rigs/space/notes/plan.md',
      body: 'Confirm with legal',
      anchor: { exact: 'ship on Oct 3', prefix: '# Plan\n\nWe ', suffix: ' after the review.\n' },
      meta: { agent: 'claude-code' },
    });
  });

  it('replies to a thread', async () => {
    const backend = fakeBackend();
    const result = await call(backend, 'rig_comment', { path: 'notes/plan.md', body: 'Done.', reply_to: 'm1' });
    expect(result.text).toBe('Replied in thread m1 on notes/plan.md.');
    expect(backend.replyComment).toHaveBeenCalledWith({
      absPath: '/rigs/space/notes/plan.md',
      parentId: 'm1',
      body: 'Done.',
      meta: { agent: 'claude-code' },
    });
  });

  it('refuses a quote that is not in the file, an empty body, and both quote and reply_to', async () => {
    const backend = fakeBackend();
    const missing = await call(backend, 'rig_comment', { path: 'notes/plan.md', body: 'x', quote: 'ship in November' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("isn't in notes/plan.md word for word");
    expect((await call(backend, 'rig_comment', { path: 'notes/plan.md', body: '  ' })).isError).toBe(true);
    expect((await call(backend, 'rig_comment', { path: 'notes/plan.md', body: 'x' })).text).toContain('needs quote');
    expect(
      (await call(backend, 'rig_comment', { path: 'notes/plan.md', body: 'x', quote: 'ship on Oct 3', reply_to: 'm1' })).isError
    ).toBe(true);
    expect(backend.createComment).not.toHaveBeenCalled();
    expect(backend.replyComment).not.toHaveBeenCalled();
  });

  it('never writes outside the space', async () => {
    const backend = fakeBackend();
    expect((await call(backend, 'rig_comment', { path: '../x.md', body: 'x', quote: 'y' })).isError).toBe(true);
    expect(backend.readText).not.toHaveBeenCalled();
  });
});

describe('anchorFor', () => {
  it('keeps up to 32 characters of real text either side', () => {
    const text = `${'a'.repeat(40)}QUOTE${'b'.repeat(40)}`;
    expect(anchorFor(text, 'QUOTE')).toEqual({ exact: 'QUOTE', prefix: 'a'.repeat(32), suffix: 'b'.repeat(32) });
    expect(anchorFor(text, 'missing')).toBeNull();
    expect(anchorFor(text, '')).toBeNull();
  });
});
