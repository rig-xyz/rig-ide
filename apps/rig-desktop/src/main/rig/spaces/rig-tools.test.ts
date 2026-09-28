import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RigCommentMessage } from '@shared/rig/comments';
import type { AcpPermissionRequest } from '@emdash/core/acp';
import type { AgentConfig } from './dispatch';
import type { RoomMessageRow } from './relay-api';
import {
  ALWAYS_ASK_RIG_TOOLS,
  anchorFor,
  CHAT_HISTORY_MAX_CHARS,
  createOwnerApprovals,
  createRigTools,
  preApprovedRigToolOption,
  PRE_APPROVED_RIG_TOOLS,
  runRigTool,
  SPACE_NAME_MAX,
  wideningParts,
  type RigTool,
  type RigToolScope,
  type RigToolsBackend,
} from './rig-tools';

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
    renameSpace: vi.fn(async (_bindingId, _root, name) => ok({ name })),
    listMessages: chatRelay([]),
    runAnswer: vi.fn(async () => null),
    agentConfig: vi.fn(async () => ok(CONFIG)),
    setAgentConfig: vi.fn(async (_scope, change) =>
      ok({
        ...CONFIG,
        model: { ...CONFIG.model!, selected: change.model ?? CONFIG.model!.selected },
        effort: { ...CONFIG.effort!, selected: change.effort ?? CONFIG.effort!.selected },
      })
    ),
    roomSees: vi.fn(() => 'steps' as const),
    setRoomSees: vi.fn(),
    listSpaceConnectors: vi.fn(async () => ok(['linear'])),
    addSpaceConnector: vi.fn(async () => ok(undefined)),
    removeSpaceConnector: vi.fn(async () => ok(undefined)),
    takeOwnerApproval: vi.fn(() => false),
    ...over,
  };
}

const CONFIG: AgentConfig = {
  model: {
    selected: 'opus',
    options: [
      { id: 'opus', name: 'Opus 4.7' },
      { id: 'sonnet', name: 'Sonnet 4.6' },
    ],
  },
  effort: {
    selected: 'medium',
    options: [
      { id: 'low', name: 'low' },
      { id: 'medium', name: 'medium' },
      { id: 'high', name: 'high' },
    ],
  },
  mode: { selected: 'default', options: [{ id: 'default', name: 'Default' }, { id: 'bypassPermissions', name: 'Bypass' }] },
};

function msg(seq: number, over: Partial<RoomMessageRow> = {}): RoomMessageRow {
  return {
    id: `m${seq}`,
    seq,
    // Message authors carry the Clerk id (Sam's is c2), as the relay sends them.
    author: { userId: 'c2', name: null, avatarUrl: null, kind: 'user' },
    kind: 'text',
    body: `message ${seq}`,
    meta: null,
    createdAt: '2026-09-25T10:00:00Z',
    ...over,
  };
}

/** The relay's message list over one space's `history` (ascending seq): `latest` and `after`/`limit`, each capped at 500. */
function chatRelay(history: RoomMessageRow[]) {
  return vi.fn(async (_bindingId: string, query: { latest?: number; after?: string; limit?: number }) => {
    if (query.latest !== undefined) return ok(history.slice(-Math.min(query.latest, 500)));
    const after = Number(query.after ?? 0);
    return ok(history.filter((row) => row.seq > after).slice(0, Math.min(query.limit ?? 200, 500)));
  });
}

function tool(backend: RigToolsBackend, name: string): RigTool {
  return createRigTools(backend, () => NOW).find((t) => t.name === name)!;
}

async function call(backend: RigToolsBackend, name: string, input: Record<string, unknown> = {}) {
  return runRigTool(backend, tool(backend, name), SCOPE, input);
}

describe('rig tools', () => {
  it('are the nine tools, each saying when to use it', () => {
    const tools = createRigTools(fakeBackend());
    expect(tools.map((t) => t.name)).toEqual([
      'rig_invite',
      'rig_people',
      'rig_recent_changes',
      'rig_chat_history',
      'rig_file_comments',
      'rig_comment',
      'rig_rename_space',
      'rig_settings',
      'rig_update_settings',
    ]);
    for (const t of tools) expect(t.description).toMatch(/Use it when|Use it whenever/);
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      'rig_people',
      'rig_recent_changes',
      'rig_chat_history',
      'rig_file_comments',
      'rig_settings',
    ]);
  });

  it('each say what they do up front, so a truncated listing still tells them apart', () => {
    const openings = createRigTools(fakeBackend()).map((t) => t.description.slice(0, 60));
    expect(new Set(openings).size).toBe(openings.length);
    for (const opening of openings) expect(opening).toMatch(/^(Invite|List|Read|Add|Rename|Change) /);
  });

  it('pre-approve only tools that are read-only', () => {
    const tools = createRigTools(fakeBackend());
    for (const name of PRE_APPROVED_RIG_TOOLS) {
      expect(tools.find((t) => t.name === name)?.annotations.readOnlyHint).toBe(true);
    }
    expect([...PRE_APPROVED_RIG_TOOLS]).not.toContain('rig_invite');
    expect([...PRE_APPROVED_RIG_TOOLS]).not.toContain('rig_comment');
    expect([...PRE_APPROVED_RIG_TOOLS]).not.toContain('rig_rename_space');
    expect([...PRE_APPROVED_RIG_TOOLS]).toContain('rig_chat_history');
    expect([...PRE_APPROVED_RIG_TOOLS]).toContain('rig_settings');
    expect([...PRE_APPROVED_RIG_TOOLS]).not.toContain('rig_update_settings');
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

describe('rig_chat_history', () => {
  const long = `Launch plan: ${'every detail spelled out. '.repeat(40)}The end.`;

  it("reads this space's latest chat in full: people, agents and their replies, comments", async () => {
    const backend = fakeBackend({
      listMessages: chatRelay([
        msg(3, { body: long }),
        msg(5, { author: { userId: 'c1', name: null, avatarUrl: null, kind: 'agent' }, meta: { agent: 'codex' }, body: 'Posted the notes.' }),
        msg(8, { kind: 'session', body: 'Summarise the launch plan', meta: { runId: 'run-1' } }),
        msg(9, { path: 'notes/plan.md', quote: 'ship on Oct 3', body: 'Is this date right?' }),
        msg(10, { parentId: 'm9', author: { userId: 'c1', name: null, avatarUrl: null, kind: 'user' }, body: 'Yes, confirmed.' }),
        msg(11, { kind: 'comment_mirror', meta: { commentId: 'x', path: 'plan.md', quote: 'budget' }, body: 'Too high?' }),
        msg(12, { body: '' }),
        msg(13, { kind: 'system', meta: { event: 'member_joined' }, body: 'joined the space', author: { userId: null, name: 'Hugo', avatarUrl: null, kind: 'user' } }),
      ]),
      runAnswer: vi.fn(async () => ({ agent: 'claude' as const, text: 'Ship Oct 3, then review.', endedAt: '2026-09-25T10:05:00Z' })),
    });
    const result = await call(backend, 'rig_chat_history');
    expect(backend.listMessages).toHaveBeenCalledWith('b1', { latest: 30 });
    expect(backend.runAnswer).toHaveBeenCalledWith('b1', 'run-1');
    expect(result.isError).toBeUndefined();
    const blocks = [
        `#3 · 2026-09-25T10:00:00Z · Sam · message\n${long}`,
        "#5 · 2026-09-25T10:00:00Z · Dylan's Codex · message\nPosted the notes.",
        "#8 · 2026-09-25T10:00:00Z · Sam · asked Sam's Claude\nSummarise the launch plan\n\n#8 · 2026-09-25T10:05:00Z · Sam's Claude · reply\nShip Oct 3, then review.",
        '#9 · 2026-09-25T10:00:00Z · Sam · comment\ncommented on notes/plan.md: “ship on Oct 3” — Is this date right?',
        '#10 · 2026-09-25T10:00:00Z · Dylan · comment\nreplied on notes/plan.md — Yes, confirmed.',
        '#11 · 2026-09-25T10:00:00Z · Sam · comment\ncommented on plan.md: “budget” — Too high?',
        '#13 · 2026-09-25T10:00:00Z · Hugo · system\njoined the space',
    ];
    expect(result.text).toBe(`This space's chat, oldest first (7 messages):\n\n${blocks.join('\n\n')}\n\nThat's the start of the chat.`);
    // The full message, not the 600-character cut of the turn's own context.
    expect(long.length).toBeGreaterThan(600);
  });

  it('pages back with before_seq, and says where to go next', async () => {
    const history = Array.from({ length: 40 }, (_, i) => msg((i + 1) * 7));
    const backend = fakeBackend({ listMessages: chatRelay(history) });

    const latest = await call(backend, 'rig_chat_history', { tail: 5 });
    expect(latest.text).toContain('(5 messages)');
    expect(latest.text).toContain('#252 ·');
    expect(latest.text).toContain('#280 ·');
    expect(latest.text).not.toContain('#245 ·');
    expect(latest.text).toContain('For older messages, call rig_chat_history with before_seq=252.');

    const older = await call(backend, 'rig_chat_history', { tail: 5, before_seq: 252 });
    expect(backend.listMessages).toHaveBeenLastCalledWith('b1', { latest: 500 });
    expect(older.text).toContain('#217 ·');
    expect(older.text).toContain('#245 ·');
    expect(older.text).not.toContain('#252 ·');
    expect(older.text).toContain('before_seq=217.');

    const first = await call(backend, 'rig_chat_history', { tail: 5, before_seq: 21 });
    expect(first.text).toContain('(2 messages)');
    expect(first.text).toContain("That's the start of the chat.");
    expect(await call(backend, 'rig_chat_history', { before_seq: 7 })).toEqual({ text: 'No messages before #7.' });
  });

  it("reaches messages older than the relay's newest page by walking forward from earlier seqs", async () => {
    // 1,200 messages; seqs are shared by every space, so this one's are sparse.
    const history = Array.from({ length: 1_200 }, (_, i) => msg(1_000 + i * 3));
    const backend = fakeBackend({ listMessages: chatRelay(history) });
    const oldestOfNewestPage = history[700]!.seq; // 3100
    const result = await call(backend, 'rig_chat_history', { tail: 3, before_seq: oldestOfNewestPage });
    expect(result.text).toContain('(3 messages)');
    expect(result.text).toContain('#3091 ·');
    expect(result.text).toContain('#3097 ·');
    expect(result.text).not.toContain('#3100 ·');
    expect(result.text).toContain('before_seq=3091.');
    expect(backend.listMessages).toHaveBeenCalledWith('b1', expect.objectContaining({ after: expect.any(String), limit: 500 }));

    const start = await call(backend, 'rig_chat_history', { tail: 3, before_seq: 1_004 });
    expect(start.text).toContain('#1000 ·');
    expect(start.text).toContain("That's the start of the chat.");
  });

  it('searches message text, files and quotes in any case, newest matches last', async () => {
    const backend = fakeBackend({
      listMessages: chatRelay([
        msg(1, { body: 'The LAUNCH is on' }),
        msg(2, { body: 'unrelated' }),
        msg(3, { path: 'launch.md', body: 'Looks good' }),
        msg(4, { body: 'launch moved' }),
      ]),
    });
    const result = await call(backend, 'rig_chat_history', { query: ' Launch ', tail: 2 });
    expect(backend.listMessages).toHaveBeenCalledWith('b1', { latest: 500 });
    expect(result.text).toContain('3 of the 4 messages searched (#1–#4) match "Launch"; 2 shown, oldest first:');
    expect(result.text).toContain('commented on launch.md — Looks good');
    expect(result.text).toContain('launch moved');
    expect(result.text).not.toContain('The LAUNCH is on');
    expect(result.text).toContain('To search older messages, call rig_chat_history with before_seq=3.');

    const none = await call(backend, 'rig_chat_history', { query: 'budget' });
    expect(none.text).toBe('No messages matching "budget" in the 4 messages searched (#1–#4).\n\nThat\'s the start of the chat.');
  });

  it('keeps a call to about 40k characters, dropping the oldest and saying how to page back', async () => {
    const big = 'x'.repeat(CHAT_HISTORY_MAX_CHARS / 2);
    const backend = fakeBackend({ listMessages: chatRelay([msg(1, { body: big }), msg(2, { body: big }), msg(3, { body: big })]) });
    const result = await call(backend, 'rig_chat_history');
    expect(result.text).toContain('(1 message)');
    expect(result.text).toContain('#3 ·');
    expect(result.text).not.toContain('#2 ·');
    expect(result.text).toContain('(Stopped at about 40k characters.)');
    expect(result.text).toContain('For older messages, call rig_chat_history with before_seq=3.');
    expect(result.text.length).toBeLessThan(CHAT_HISTORY_MAX_CHARS + 500);

    // One message longer than the budget is shown cut, not dropped.
    const huge = fakeBackend({ listMessages: chatRelay([msg(1, { body: 'y'.repeat(CHAT_HISTORY_MAX_CHARS * 2) })]) });
    const cut = await call(huge, 'rig_chat_history');
    expect(cut.text).toContain('…(cut: this message is too long to show in full)');
    expect(cut.text.length).toBeLessThan(CHAT_HISTORY_MAX_CHARS + 500);
  });

  it("only reads the session's own space, and passes on a relay failure", async () => {
    const backend = fakeBackend({ listMessages: vi.fn(async () => err({ message: 'You are offline.' })) });
    const result = await runRigTool(backend, tool(backend, 'rig_chat_history'), { ...SCOPE, bindingId: 'b2' }, {});
    expect(backend.listMessages).toHaveBeenCalledWith('b2', { latest: 30 });
    expect(backend.listMessages).not.toHaveBeenCalledWith('b1', expect.anything());
    expect(result).toEqual({ text: "Couldn't load the space's chat: You are offline.", isError: true });
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

describe('rig_rename_space', () => {
  it('renames the space through its folder, with the name trimmed onto one line', async () => {
    const backend = fakeBackend();
    const result = await call(backend, 'rig_rename_space', { name: '  Launch\n  planning ' });
    expect(backend.renameSpace).toHaveBeenCalledWith('b1', '/rigs/space', 'Launch planning');
    expect(result).toEqual({ text: 'Renamed this space to "Launch planning". Everyone in it will see the new name.' });
  });

  it('lets an editor rename, not a viewer', async () => {
    const asRole = (role: string) =>
      fakeBackend({
        listMembers: async () =>
          ok([{ userId: 'u-dylan', clerkUserId: 'c1', name: 'Dylan', email: 'dylan@rig.xyz', role, avatarUrl: null }]),
      });
    const editor = asRole('editor');
    expect((await call(editor, 'rig_rename_space', { name: 'Launch planning' })).isError).toBeUndefined();
    expect(editor.renameSpace).toHaveBeenCalled();

    const viewer = asRole('viewer');
    const refused = await call(viewer, 'rig_rename_space', { name: 'Launch planning' });
    expect(refused).toEqual({
      text: "Your owner is a viewer in this space, so they can't rename it. Ask an owner or editor to.",
      isError: true,
    });
    expect(viewer.renameSpace).not.toHaveBeenCalled();
  });

  it("refuses when the owner's role can't be checked, or they aren't a member", async () => {
    const offline = fakeBackend({ listMembers: async () => err({ message: 'network down' }) });
    const unchecked = await call(offline, 'rig_rename_space', { name: 'Launch planning' });
    expect(unchecked.isError).toBe(true);
    expect(unchecked.text).toContain('network down');
    const gone = fakeBackend({ listMembers: async () => ok([]) });
    expect((await call(gone, 'rig_rename_space', { name: 'Launch planning' })).isError).toBe(true);
    expect(offline.renameSpace).not.toHaveBeenCalled();
    expect(gone.renameSpace).not.toHaveBeenCalled();
  });

  it("refuses an empty or too-long name, and a folder that isn't this space's any more", async () => {
    const backend = fakeBackend();
    expect((await call(backend, 'rig_rename_space', { name: '   ' })).isError).toBe(true);
    expect((await call(backend, 'rig_rename_space', {})).isError).toBe(true);
    expect((await call(backend, 'rig_rename_space', { name: 'x'.repeat(SPACE_NAME_MAX) })).isError).toBeUndefined();
    const long = await call(backend, 'rig_rename_space', { name: 'x'.repeat(SPACE_NAME_MAX + 1) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain(`${SPACE_NAME_MAX} or fewer`);
    expect(backend.renameSpace).toHaveBeenCalledTimes(1);
    const moved = fakeBackend({ bindingAt: () => 'b-other' });
    expect((await call(moved, 'rig_rename_space', { name: 'Launch planning' })).isError).toBe(true);
    expect(moved.renameSpace).not.toHaveBeenCalled();
  });

  it('passes on a failed rename', async () => {
    const backend = fakeBackend({ renameSpace: async () => err({ message: 'Could not save rig.toml: EACCES' }) });
    expect(await call(backend, 'rig_rename_space', { name: 'Launch planning' })).toEqual({
      text: "Couldn't rename the space: Could not save rig.toml: EACCES",
      isError: true,
    });
  });
});

describe('rig_settings', () => {
  it("reads the session's own agent settings in its space, with the valid choices", async () => {
    const backend = fakeBackend();
    const result = await call(backend, 'rig_settings');
    expect(backend.agentConfig).toHaveBeenCalledWith(SCOPE);
    expect(backend.roomSees).toHaveBeenCalledWith('b1');
    expect(backend.listSpaceConnectors).toHaveBeenCalledWith('b1');
    expect(result.text).toContain("Your owner's Claude in this space");
    expect(result.text).toContain('- Model: opus (Opus 4.7); choices: opus (Opus 4.7), sonnet (Sonnet 4.6)');
    expect(result.text).toContain('- Effort: medium; choices: low, medium, high');
    expect(result.text).toContain('- Permissions: default (Default) (your owner changes this themselves, in the space panel)');
    expect(result.text).toContain('- Chat sees: steps, your steps, not what your tools returned; choices: answer (only your final reply)');
    expect(result.text).toContain('linear (Linear)');
    expect(result.text).toMatch(/Others that can be turned on: .*notion/);
  });

  it("still reads chat sees and connectors when the agent's settings can't be reached", async () => {
    const backend = fakeBackend({ agentConfig: vi.fn(async () => err({ message: "this space's folder isn't open on this device" })) });
    const result = await call(backend, 'rig_settings');
    expect(result.text).toContain("Model, effort, permissions: couldn't read them");
    expect(result.text).toContain('- Chat sees: steps');
  });
});

describe('rig_update_settings', () => {
  it("changes the session's own model and effort through the pill's path, validated against its choices", async () => {
    const backend = fakeBackend();
    const result = await call(backend, 'rig_update_settings', { model: 'Sonnet 4.6', effort: 'high' });
    expect(backend.setAgentConfig).toHaveBeenCalledWith(SCOPE, { model: 'sonnet', effort: 'high' });
    expect(result.text).toBe(
      'Changed, from your next turn:\n- model: opus (Opus 4.7) → sonnet (Sonnet 4.6)\n- effort: medium → high'
    );

    const bad = fakeBackend();
    const refused = await call(bad, 'rig_update_settings', { model: 'gpt-9', effort: 'high' });
    expect(refused).toEqual({ text: '"gpt-9" isn\'t one of the model choices (opus, sonnet), so nothing changed.', isError: true });
    expect(bad.setAgentConfig).not.toHaveBeenCalled();
    expect((await call(bad, 'rig_update_settings', {})).text).toContain('Nothing to change');
  });

  it("only ever changes the session owner's own agent, in its own space", async () => {
    const backend = fakeBackend();
    const codexInB2: RigToolScope = { ...SCOPE, bindingId: 'b2', agent: 'codex' };
    await runRigTool(backend, tool(backend, 'rig_update_settings'), codexInB2, { effort: 'low', chat_sees: 'answer' });
    expect(backend.setAgentConfig).toHaveBeenCalledWith(codexInB2, { effort: 'low' });
    expect(backend.setRoomSees).toHaveBeenCalledWith('b2', 'answer');
    // And never for someone else's session on this device.
    const other = fakeBackend({ whoami: async () => ok({ id: 'u-sam' }) });
    expect((await call(other, 'rig_update_settings', { effort: 'low' })).isError).toBe(true);
    expect(other.setAgentConfig).not.toHaveBeenCalled();
  });

  it('refuses permissions mode, auto-approve and any other unknown setting, changing nothing', async () => {
    const backend = fakeBackend({ takeOwnerApproval: vi.fn(() => true) });
    for (const input of [{ mode: 'bypassPermissions' }, { auto_approve: true, effort: 'low' }, { autoApproveAgentActions: true }]) {
      const result = await call(backend, 'rig_update_settings', input);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Permissions mode and \"Auto-approve agent actions\" are your owner's to change themselves");
    }
    expect(backend.setAgentConfig).not.toHaveBeenCalled();
    expect(backend.takeOwnerApproval).not.toHaveBeenCalled();
  });

  it('narrows chat sees without the owner approval receipt', async () => {
    const backend = fakeBackend();
    const result = await call(backend, 'rig_update_settings', { chat_sees: 'answer' });
    expect(backend.setRoomSees).toHaveBeenCalledWith('b1', 'answer');
    expect(result.text).toBe('Changed, from your next turn:\n- chat sees: steps → answer (only your final reply)');
  });

  it("turns a connector off only with the owner's fresh approval: it's gone for everyone in the space", async () => {
    const unapproved = fakeBackend();
    const refused = await call(unapproved, 'rig_update_settings', { connectors: { disable: ['linear', 'notion'] } });
    expect(unapproved.removeSpaceConnector).not.toHaveBeenCalled();
    expect(refused.text).toContain("turn off Linear: changes it for everyone in the space, needs your owner's approval");

    const approved = fakeBackend({ takeOwnerApproval: vi.fn(() => true) });
    const result = await call(approved, 'rig_update_settings', { connectors: { disable: ['linear', 'notion'] } });
    // Only one that's on is turned off.
    expect(approved.removeSpaceConnector).toHaveBeenCalledTimes(1);
    expect(approved.removeSpaceConnector).toHaveBeenCalledWith('b1', 'linear');
    expect(result.text).toBe('Changed, from your next turn:\n- Linear: turned off in this space');
  });

  it("widens chat sees or turns a connector on only with the owner's fresh approval", async () => {
    const unapproved = fakeBackend();
    const refused = await call(unapproved, 'rig_update_settings', { chat_sees: 'everything', connectors: { enable: ['notion'] }, effort: 'low' });
    expect(unapproved.setRoomSees).not.toHaveBeenCalled();
    expect(unapproved.addSpaceConnector).not.toHaveBeenCalled();
    // The rest of the call still goes through.
    expect(unapproved.setAgentConfig).toHaveBeenCalledWith(SCOPE, { effort: 'low' });
    expect(refused.text).toContain("- chat sees steps → everything: needs your owner's approval");
    expect(refused.text).toContain("- turn on Notion: needs your owner's approval");
    expect(refused.text).toContain('Ask them to allow it when prompted, or to change it themselves in the space panel.');

    const approved = fakeBackend({ takeOwnerApproval: vi.fn(() => true) });
    const done = await call(approved, 'rig_update_settings', { chat_sees: 'everything', connectors: { enable: ['notion', 'linear'] } });
    expect(approved.takeOwnerApproval).toHaveBeenCalledWith(SCOPE);
    expect(approved.setRoomSees).toHaveBeenCalledWith('b1', 'everything');
    expect(approved.addSpaceConnector).toHaveBeenCalledTimes(1);
    expect(approved.addSpaceConnector).toHaveBeenCalledWith('b1', 'notion');
    expect(done.isError).toBeUndefined();
  });

  it("refuses an unknown connector, and passes on the relay's refusal", async () => {
    const backend = fakeBackend({ takeOwnerApproval: () => true });
    expect((await call(backend, 'rig_update_settings', { connectors: { enable: ['myspace'] } })).text).toContain('No connector called myspace');
    const viewer = fakeBackend({
      takeOwnerApproval: () => true,
      addSpaceConnector: vi.fn(async () => err({ message: "You don't have permission to do that." })),
    });
    const result = await call(viewer, 'rig_update_settings', { connectors: { enable: ['notion'] } });
    expect(result).toEqual({ text: "Nothing changed.\n\nNot changed:\n- turn on Notion: You don't have permission to do that.", isError: true });
  });
});

describe('the always-ask carve-out', () => {
  const request = (title: string): AcpPermissionRequest =>
    ({
      requestId: 'r1',
      toolCall: { toolCallId: 't1', title },
      options: [
        { optionId: 'once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
      ],
    }) as unknown as AcpPermissionRequest;

  it('flags only the parts of a change that widen access', () => {
    const current = { chatSees: 'steps' as const, connectors: ['linear'] };
    expect(wideningParts({ chat_sees: 'everything' }, current)).toEqual(['chat sees steps → everything']);
    expect(wideningParts({ connectors: { enable: ['notion', 'linear'] } }, current)).toEqual(['turn on Notion']);
    expect(wideningParts({ chat_sees: 'answer', connectors: { disable: ['linear'] }, model: 'sonnet', effort: 'high' }, current)).toEqual([]);
    expect(wideningParts({ chat_sees: 'steps' }, current)).toEqual([]);
  });

  it('never pre-approves rig_update_settings, while the read-only tools still are', () => {
    expect(ALWAYS_ASK_RIG_TOOLS.has('rig_update_settings')).toBe(true);
    expect(preApprovedRigToolOption(request('mcp__rig__rig_update_settings'))).toBeNull();
    expect(preApprovedRigToolOption(request('mcp.rig.rig_update_settings'))).toBeNull();
    expect(preApprovedRigToolOption(request('mcp__rig__rig_settings'))).toBe('once');
    expect(preApprovedRigToolOption(request('mcp.rig.rig_chat_history'))).toBe('once');
  });

  it("keeps an owner's approval for one call, briefly", () => {
    let now = 0;
    const approvals = createOwnerApprovals(() => now);
    expect(approvals.take('b1::u::claude')).toBe(false);
    approvals.record('b1::u::claude');
    expect(approvals.take('b1::u::codex')).toBe(false);
    expect(approvals.take('b1::u::claude')).toBe(true);
    expect(approvals.take('b1::u::claude')).toBe(false);
    approvals.record('b1::u::claude');
    now = 3 * 60_000;
    expect(approvals.take('b1::u::claude')).toBe(false);
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
