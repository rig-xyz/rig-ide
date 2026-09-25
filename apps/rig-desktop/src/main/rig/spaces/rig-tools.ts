import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { z } from 'zod';
import { filterToContentOnly } from '@shared/rig/file-navigator-categories';
import type { RigCommentAnchor, RigCommentMessage } from '@shared/rig/comments';
import type { RigFileNode } from '@shared/rig/files';
import type { RigInviteMinted, RigInviteRole } from '@shared/rig/rig-share';
import type { RoomInviteRow, RoomMemberRow, SessionAgent } from './relay-api';

/**
 * Rig tools: first-class tools a room agent calls directly (invite someone,
 * who's here, what changed, a file's comments) instead of shelling out to the
 * `rig` CLI and feeling its way with `--help`, `cat` and `ls`. Served to each
 * session by the desktop's own local MCP server (`rig-tools-server.ts`) under
 * the name `rig`, next to the space's connectors.
 *
 * Every tool acts as the signed-in member who owns the session, with exactly
 * their relay permissions, and only on the one space the session belongs to:
 * each call first checks this device is still signed in as that member, and
 * every path is checked to stay inside the space's folder and binding.
 *
 * No new backend: each tool reuses what the desktop already does — the Share
 * popover's invite, the Room's member and invite lists, Details → Changes
 * (the space's files by last change, and Pulse's one-line story of who did
 * what), and the doc margin's comments layer. `RigToolsBackend` is that seam,
 * faked in tests; `rig-tools-instance.ts` wires the real one.
 */

/** Who a session's rig tools act as, and where. */
export type RigToolScope = {
  bindingId: string;
  /** The member who owns the session (their relay user id). */
  ownerUserId: string;
  agent: SessionAgent;
  /** The space's folder on this device. */
  cwd: string;
};

type Failure = { message: string };

export interface RigToolsBackend {
  /** The signed-in account's relay user id. */
  whoami(): Promise<Result<{ id: string }, Failure>>;
  /** The binding a folder belongs to (walking up), or null when none. */
  bindingAt(dir: string): string | null;
  /** The Share popover's invite: mints an email-bound invite for the space whose folder is `root`. */
  createInvite(root: string, email: string, role: RigInviteRole): Promise<Result<RigInviteMinted, Failure>>;
  listMembers(bindingId: string): Promise<Result<RoomMemberRow[], Failure>>;
  listInvites(bindingId: string): Promise<Result<RoomInviteRow[], Failure>>;
  /** Every file under the space's folder, with its last-change time. */
  listFiles(root: string): Promise<Result<RigFileNode[], Failure>>;
  /** Pulse's one-line story of the space's recent activity (who did what), or null when it has none. */
  spaceStory(bindingId: string): Promise<string | null>;
  /** A file's comments: thread roots and their replies. */
  listComments(absPath: string): Promise<Result<RigCommentMessage[], Failure>>;
  /** A file's text, to pin a new comment to a passage in it; null when it can't be read. */
  readText(root: string, relPath: string): Promise<string | null>;
  createComment(input: {
    absPath: string;
    body: string;
    anchor: RigCommentAnchor;
    meta: Record<string, unknown>;
  }): Promise<Result<RigCommentMessage, Failure>>;
  replyComment(input: {
    absPath: string;
    parentId: string;
    body: string;
    meta: Record<string, unknown>;
  }): Promise<Result<RigCommentMessage, Failure>>;
}

export type RigToolResult = { text: string; isError?: boolean };

export type RigTool = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  run: (scope: RigToolScope, input: Record<string, unknown>) => Promise<RigToolResult>;
};

const RECENT_FILES_MAX = 25;
/** Context kept around a new comment's quote: the CLI's and the doc margin's (`renderer/features/docs/comments/anchors.ts`). */
const ANCHOR_CONTEXT = 32;

function failed(text: string): RigToolResult {
  return { text, isError: true };
}

/** "notes/plan.md" in the space's folder, or why not: never a path outside it. */
function spacePath(scope: RigToolScope, input: string): Result<{ absPath: string; relPath: string }, string> {
  const absPath = resolve(scope.cwd, input.trim());
  const rel = relative(scope.cwd, absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return err(`"${input}" isn't a file in this space. Give a path relative to the space's folder, like notes/plan.md.`);
  }
  return ok({ absPath, relPath: rel.split(sep).join('/') });
}

/** The same path, and only when it belongs to this space's binding (not a different rig nested inside it). */
function spaceFile(
  backend: RigToolsBackend,
  scope: RigToolScope,
  input: string
): Result<{ absPath: string; relPath: string }, string> {
  const path = spacePath(scope, input);
  if (!path.success) return path;
  if (backend.bindingAt(dirname(path.data.absPath)) !== scope.bindingId) {
    return err(`"${input}" isn't part of this space.`);
  }
  return path;
}

function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function flattenFiles(nodes: readonly RigFileNode[]): RigFileNode[] {
  return nodes.flatMap((node) => (node.kind === 'dir' ? flattenFiles(node.children ?? []) : [node]));
}

function authorName(message: RigCommentMessage): string {
  const name = message.author.name ?? 'someone';
  if (message.author.kind !== 'agent') return name;
  const agent = typeof message.meta?.agent === 'string' ? message.meta.agent : null;
  return agent ? `${name}'s agent (${agent})` : `${name}'s agent`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A new comment's anchor: the quote must be verbatim in the file, with a little real text either side. */
export function anchorFor(text: string, quote: string): RigCommentAnchor | null {
  const idx = text.indexOf(quote);
  if (!quote || idx === -1) return null;
  const end = idx + quote.length;
  return {
    exact: quote,
    prefix: text.slice(Math.max(0, idx - ANCHOR_CONTEXT), idx),
    suffix: text.slice(end, end + ANCHOR_CONTEXT),
  };
}

/** The comment author label the doc margin shows for an agent (same values as the comment agent's). */
function agentLabel(agent: SessionAgent): string {
  return agent === 'claude' ? 'claude-code' : agent;
}

export function createRigTools(backend: RigToolsBackend, now: () => number = Date.now): RigTool[] {
  return [
    {
      name: 'rig_invite',
      description:
        "Invite a person to this rig space by email. Use it whenever you're asked to invite, add or share the space with someone, instead of running `rig share`: the request is the go-ahead. " +
        'It emails them an invite and returns the join link, which you can also pass on. ' +
        'role is editor (can edit files and ask their own agents; the default) or viewer (read-only). ' +
        "Owners and editors can invite; if your owner can't, the result says so.",
      inputSchema: {
        email: z.string().describe("The person's email address."),
        role: z.enum(['editor', 'viewer']).optional().describe('editor (default) or viewer.'),
      },
      annotations: { title: 'Invite to this space', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      run: async (scope, input) => {
        const email = String(input.email ?? '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return failed(`"${email}" doesn't look like an email address.`);
        const role: RigInviteRole = input.role === 'viewer' ? 'viewer' : 'editor';
        if (backend.bindingAt(scope.cwd) !== scope.bindingId) {
          return failed("This space's folder on this device isn't linked to the space any more, so no invite was sent.");
        }
        const minted = await backend.createInvite(scope.cwd, email, role);
        if (!minted.success) return failed(`Couldn't invite ${email}: ${minted.error.message}`);
        const { email: sent, url } = minted.data;
        const emailLine = sent.sent
          ? `Invite email sent to ${sent.to ?? email}.`
          : `No invite email went out${sent.reason ? ` (${sent.reason})` : ''}; share the link with them yourself.`;
        return { text: [`Invited ${email} to this space as ${role}.`, emailLine, `Join link (only ${email} can use it): ${url}`].join('\n') };
      },
    },
    {
      name: 'rig_people',
      description:
        "List who is in this rig space (name, email, role) and the invites still waiting to be accepted. Use it when asked who has access or who's here, and before inviting someone who may already be a member.",
      inputSchema: {},
      annotations: { title: "Who's in this space", readOnlyHint: true },
      run: async (scope) => {
        const [members, invites] = await Promise.all([
          backend.listMembers(scope.bindingId),
          backend.listInvites(scope.bindingId),
        ]);
        if (!members.success) return failed(`Couldn't load the space's members: ${members.error.message}`);
        const lines = [`Members (${members.data.length}):`];
        for (const m of members.data) {
          const name = m.name ?? m.email?.split('@')[0] ?? 'someone';
          const you = m.userId === scope.ownerUserId ? ' (your owner)' : '';
          lines.push(`- ${name}${m.email ? ` <${m.email}>` : ''}: ${m.role}${you}`);
        }
        if (!invites.success) {
          lines.push('', `Pending invites: couldn't load them (${invites.error.message}).`);
        } else {
          // Same rule as the Room: an invite counts as joined once a member has its email.
          const memberEmails = new Set(members.data.map((m) => m.email?.toLowerCase()).filter(Boolean));
          const pending = invites.data.filter((i) => !i.revoked && !(i.email && memberEmails.has(i.email.toLowerCase())));
          lines.push('', pending.length > 0 ? `Pending invites (${pending.length}):` : 'No pending invites.');
          for (const i of pending) lines.push(`- ${i.email ?? 'invite link'}: ${i.role}`);
        }
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'rig_recent_changes',
      description:
        "What changed recently in this rig space: the files changed in the last `hours` (default 24), newest first, and rig's one-line summary of who (people and their agents) did what. " +
        "Use it when asked what's new, what changed, or what people have been working on. For one file's full history, use `rig history <path>`.",
      inputSchema: {
        hours: z.number().int().min(1).max(24 * 14).optional().describe('How far back to look, in hours (default 24).'),
      },
      annotations: { title: 'Recent changes in this space', readOnlyHint: true },
      run: async (scope, input) => {
        const hours = typeof input.hours === 'number' ? input.hours : 24;
        const [files, story] = await Promise.all([
          backend.listFiles(scope.cwd),
          backend.spaceStory(scope.bindingId).catch(() => null),
        ]);
        if (!files.success) return failed(`Couldn't read the space's files: ${files.error.message}`);
        const at = now();
        const cutoff = at - hours * 60 * 60 * 1000;
        const changed = flattenFiles(filterToContentOnly(files.data))
          .filter((f) => (f.mtimeMs ?? 0) >= cutoff)
          .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
        const lines: string[] = [];
        if (story) lines.push(`Summary: ${story}`, '');
        if (changed.length === 0) {
          lines.push(`No files changed in the last ${hours} h.`);
        } else {
          lines.push(`${changed.length} ${changed.length === 1 ? 'file' : 'files'} changed in the last ${hours} h, newest first:`);
          for (const f of changed.slice(0, RECENT_FILES_MAX)) lines.push(`- ${f.relPath} (${ago(f.mtimeMs!, at)})`);
          if (changed.length > RECENT_FILES_MAX) lines.push(`- …and ${changed.length - RECENT_FILES_MAX} more`);
        }
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'rig_file_comments',
      description:
        "Read the comment threads on a file in this rig space: each thread's id, the passage it's pinned to, and who said what (people and agents). " +
        'Use it when asked about comments, feedback or open questions on a file, and before replying with rig_comment. ' +
        "path is relative to the space's folder. Resolved threads are left out unless include_resolved is true.",
      inputSchema: {
        path: z.string().describe("The file, relative to the space's folder, e.g. notes/plan.md."),
        include_resolved: z.boolean().optional().describe('Also show resolved threads.'),
      },
      annotations: { title: "A file's comments", readOnlyHint: true },
      run: async (scope, input) => {
        const file = spaceFile(backend, scope, String(input.path ?? ''));
        if (!file.success) return failed(file.error);
        const listed = await backend.listComments(file.data.absPath);
        if (!listed.success) return failed(`Couldn't load the comments on ${file.data.relPath}: ${listed.error.message}`);
        const live = listed.data.filter((m) => !m.deletedAt);
        const roots = live.filter((m) => !m.parentId && (input.include_resolved === true || !m.resolvedAt));
        if (roots.length === 0) return { text: `No ${input.include_resolved === true ? '' : 'open '}comments on ${file.data.relPath}.` };
        const lines = [`${roots.length} ${roots.length === 1 ? 'thread' : 'threads'} on ${file.data.relPath}:`];
        for (const root of roots) {
          const quote = root.anchor?.exact ? ` on “${oneLine(root.anchor.exact).slice(0, 160)}”` : '';
          lines.push('', `Thread ${root.id}${quote}${root.resolvedAt ? ' (resolved)' : ''}`);
          lines.push(`- ${authorName(root)}: ${oneLine(root.body)}`);
          for (const reply of live.filter((m) => m.parentId === root.id)) {
            lines.push(`  - ${authorName(reply)}: ${oneLine(reply.body)}`);
          }
        }
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'rig_comment',
      description:
        'Add a comment on a file in this rig space, or reply to a thread on it. Everyone in the space sees it, marked as written by you (the agent) for your owner. ' +
        'New thread: give quote, a passage copied exactly from the file, which the comment is pinned to. ' +
        'Reply: give reply_to, a thread id from rig_file_comments, and no quote. ' +
        'Use it when asked to comment on, annotate or review a file, or to answer feedback on it, instead of `rig comment`.',
      inputSchema: {
        path: z.string().describe("The file, relative to the space's folder, e.g. notes/plan.md."),
        body: z.string().describe('The comment, in markdown.'),
        quote: z.string().optional().describe('For a new thread: the exact passage from the file to pin it to.'),
        reply_to: z.string().optional().describe('For a reply: the thread id (from rig_file_comments).'),
      },
      annotations: { title: 'Comment on a file', readOnlyHint: false, destructiveHint: false },
      run: async (scope, input) => {
        const file = spaceFile(backend, scope, String(input.path ?? ''));
        if (!file.success) return failed(file.error);
        const body = String(input.body ?? '').trim();
        if (!body) return failed('A comment needs some text.');
        const replyTo = typeof input.reply_to === 'string' ? input.reply_to.trim() : '';
        const quote = typeof input.quote === 'string' ? input.quote : '';
        if (replyTo && quote) return failed('Give either quote (a new thread) or reply_to (a reply), not both.');
        const meta = { agent: agentLabel(scope.agent) };
        const { absPath, relPath } = file.data;

        if (replyTo) {
          const posted = await backend.replyComment({ absPath, parentId: replyTo, body, meta });
          if (!posted.success) return failed(`Couldn't post the reply on ${relPath}: ${posted.error.message}`);
          return { text: `Replied in thread ${replyTo} on ${relPath}.` };
        }
        if (!quote.trim()) return failed('A new comment needs quote: the exact passage from the file to pin it to.');
        const text = await backend.readText(scope.cwd, relPath);
        if (text === null) return failed(`Couldn't read ${relPath}.`);
        const anchor = anchorFor(text, quote);
        if (!anchor) {
          return failed(`That quote isn't in ${relPath} word for word. Copy the passage exactly as it appears in the file (same spacing and punctuation).`);
        }
        const posted = await backend.createComment({ absPath, body, anchor, meta });
        if (!posted.success) return failed(`Couldn't post the comment on ${relPath}: ${posted.error.message}`);
        return { text: `Commented on ${relPath} (thread ${posted.data.id}).` };
      },
    },
  ];
}

/**
 * Runs one tool call as the session's owner: refused when this device is no
 * longer signed in as them (a switched or signed-out account), so a tool can
 * never act with someone else's permissions. A tool that throws is an error
 * result, never a crashed request.
 */
export async function runRigTool(
  backend: RigToolsBackend,
  tool: RigTool,
  scope: RigToolScope,
  input: Record<string, unknown>
): Promise<RigToolResult> {
  try {
    const me = await backend.whoami();
    if (!me.success) return failed(`Couldn't check who's signed in to rig: ${me.error.message}`);
    if (me.data.id !== scope.ownerUserId) {
      return failed('This device is signed in to rig as someone else now, so rig tools are off for this session.');
    }
    return await tool.run(scope, input);
  } catch (error) {
    return failed(`${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
