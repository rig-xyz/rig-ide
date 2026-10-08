import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AcpPermissionRequest } from '@emdash/core/acp';
import { parseFrontmatter } from '@emdash/core/skills';
import { err, ok, type Result } from '@emdash/shared';
import * as toml from 'smol-toml';
import { z } from 'zod';
import { secretReason, syncIgnoreMatcher } from '../attachments/rules';
import { CONNECTORS, connectorById, isConnectorId, RIG_TOOLS_SERVER } from '@shared/spaces/connectors';
import { ROOM_SEES_LEVELS, type RoomSees } from '@shared/spaces/room-sees';
import {
  canonicalEmoji,
  MAX_REACTIONS_PER_RUN,
  reactionCounts,
  reactionsLabel,
  type MessageReaction,
} from '@shared/spaces/reactions';
import { filterToContentOnly } from '@shared/rig/file-navigator-categories';
import type { RigCommentAnchor, RigCommentMessage } from '@shared/rig/comments';
import type { RigFileNode } from '@shared/rig/files';
import type { RigInviteMinted, RigInviteRole, RigPeopleList } from '@shared/rig/rig-share';
import type { AgentConfig, AgentConfigChoice } from './dispatch';
import type { RoomInviteRow, RoomMemberRow, RoomMessageRow, SessionAgent } from './relay-api';

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
 * what), the doc margin's comments layer, the row menu's Rename… (a
 * `rig.toml` edit that syncs to everyone), and the Room's own message list
 * and run logs for the chat. `RigToolsBackend` is that seam,
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
  /** The connectors this session was started with (ids), and the ones from its owner's own setup. Absent: not known. */
  reachable?: { connectors: readonly string[]; global: readonly string[] };
};

/**
 * Rig's own tools a room agent runs without asking its owner: the read-only
 * ones (who's here, what changed lately, a file's comments, the chat), and
 * `rig_chat_react`, which only puts an emoji on a message (a few per turn, never a
 * message, never asks anyone). `rig_people_invite` and `rig_comments_add` act on the
 * space, so they still ask.
 */
export const PRE_APPROVED_RIG_TOOLS: ReadonlySet<string> = new Set([
  'rig_space_describe',
  'rig_people_list',
  'rig_changes_list',
  'rig_comments_read',
  'rig_chat_read',
  'rig_settings_read',
  'rig_chat_react',
]);

/**
 * Rig tools never answered without the owner, whatever else is on: not
 * pre-approved here, and a change of theirs that widens who sees or reaches
 * what also needs the owner's own fresh "allow" (`ownerApprovals`), which an
 * agent's never-ask permission mode or an "allow always" can't stand in for.
 */
export const ALWAYS_ASK_RIG_TOOLS: ReadonlySet<string> = new Set(['rig_settings_update']);

/** `rig_people_list` from a rig tool call's title as agents report it (Claude `mcp__rig__rig_people_list`, Codex `mcp.rig.rig_people_list`); null for any other tool. */
export function rigToolOf(title: string): string | null {
  const match = new RegExp(`^mcp__${RIG_TOOLS_SERVER}__(.+)$|^mcp\\.${RIG_TOOLS_SERVER}\\.(.+)$`).exec(title);
  return match ? (match[1] ?? match[2]!) : null;
}

/** The browser tools (`pages/browser-tools.ts`) only read a page as the owner: no clicks, no typing. */
export const PRE_APPROVED_BROWSER_TOOLS: ReadonlySet<string> = new Set(['rig_browser_pins', 'rig_browser_read', 'rig_browser_screenshot']);

/**
 * The read-only half of the owner's claude.ai Claude Docs connector: reading a
 * Doc someone linked in the room, its comments, and the connector's own how-to.
 * Editing and commenting (`update`, `create`, `batch`, `delete`) still ask.
 */
const PRE_APPROVED_CLAUDE_DOCS_TOOLS = ['guide', 'read', 'query'].map((tool) => `mcp__claude_ai_Claude_Docs__${tool}`);

/** Their exact names as agents report them: Claude `mcp__rig__rig_people_list`, Codex `mcp.rig.rig_people_list`. */
const PRE_APPROVED_TOOL_NAMES = new Set([
  ...[...PRE_APPROVED_RIG_TOOLS, ...PRE_APPROVED_BROWSER_TOOLS].flatMap((tool) => [`mcp__${RIG_TOOLS_SERVER}__${tool}`, `mcp.${RIG_TOOLS_SERVER}.${tool}`]),
  ...PRE_APPROVED_CLAUDE_DOCS_TOOLS,
]);

/**
 * The option that answers `request` without asking — its "allow once", never
 * an "always" — when it's one of the pre-approved read-only tools above; null
 * for anything else (other rig tools, other servers, a request with no plain
 * allow), which waits for the owner as before.
 */
export function preApprovedRigToolOption(request: AcpPermissionRequest): string | null {
  const rigTool = rigToolOf(request.toolCall.title);
  if (rigTool && ALWAYS_ASK_RIG_TOOLS.has(rigTool)) return null;
  if (!PRE_APPROVED_TOOL_NAMES.has(request.toolCall.title)) return null;
  return request.options.find((option) => option.kind === 'allow_once')?.optionId ?? null;
}

/** One session's key (space, member, agent): the dispatcher's and the rig tools server's. */
export function rigToolScopeKey(scope: Pick<RigToolScope, 'bindingId' | 'ownerUserId' | 'agent'>): string {
  return `${scope.bindingId}::${scope.ownerUserId}::${scope.agent}`;
}

/** How long the owner's "allow" stays good for the call it answered. */
const OWNER_APPROVAL_TTL_MS = 2 * 60_000;

/**
 * The owner's own "allow" on an always-ask rig tool call, as a one-use
 * receipt per session. The dispatcher records one when the owner allows the
 * call on their card (`resolvePermission`); the tool takes it when it runs.
 * No receipt (the agent's mode never asks, an earlier "allow always", or it's
 * stale) means the owner didn't just approve this call.
 */
export function createOwnerApprovals(now: () => number = Date.now) {
  const at = new Map<string, number>();
  return {
    record(key: string): void {
      at.set(key, now());
    },
    take(key: string): boolean {
      const when = at.get(key);
      at.delete(key);
      return when !== undefined && now() - when <= OWNER_APPROVAL_TTL_MS;
    },
  };
}

export const ownerApprovals = createOwnerApprovals();

type Failure = { message: string };

export interface RigToolsBackend {
  /** The signed-in account's relay user id. */
  whoami(): Promise<Result<{ id: string }, Failure>>;
  /** The binding a folder belongs to (walking up), or null when none. */
  bindingAt(dir: string): string | null;
  /** The Share popover's invite: mints an email-bound invite for the space whose folder is `root`. */
  /** `email` null mints an open link anyone can use. */
  createInvite(root: string, email: string | null, role: RigInviteRole): Promise<Result<RigInviteMinted, Failure>>;
  /** Your people: everyone you've shared a space with, by name and id, never their email. Absent or unsupported on an older app or relay. */
  listPeople?(): Promise<Result<RigPeopleList, Failure>>;
  /** Invite Board 26's way: aimed at a person, who hears about it in Rig and by email, with no address involved. */
  invitePerson?(bindingId: string, userId: string, role: RigInviteRole): Promise<Result<RigInviteMinted, Failure>>;
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
  /** The row menu's Rename…: sets the name in the space's `rig.toml` (whose folder is `root`), which syncs to every member. */
  renameSpace(bindingId: string, root: string, name: string): Promise<Result<{ name: string }, Failure>>;
  /** The space's chat as the Room loads it (`listMessages`): the newest `latest` rows, or up to `limit` rows after a seq; oldest first either way. */
  listMessages(bindingId: string, query: { latest?: number; after?: string; limit?: number }): Promise<Result<RoomMessageRow[], Failure>>;
  /** An agent run's final answer (read from its log, as the dispatcher's room context does), its agent and end time; null when unreadable. */
  runAnswer(bindingId: string, runId: string): Promise<{ agent: SessionAgent; text: string; endedAt: string | null } | null>;
  /** The session's own agent settings in its space: the agent settings pill's `agentConfig`. */
  agentConfig(scope: RigToolScope): Promise<Result<AgentConfig, Failure>>;
  /** The pill's `setAgentConfig` (model / effort; applies from the next turn), for the session's own agent only. */
  setAgentConfig(scope: RigToolScope, change: { model?: string; effort?: string }): Promise<Result<AgentConfig, Failure>>;
  /** "Chat sees" in a space, on this computer (`RigSettings.spacesRoomSees`). */
  roomSees(bindingId: string): RoomSees;
  /** Saves it the way the pill does, so the pill and `trace-privacy.ts` pick it up. */
  setRoomSees(bindingId: string, level: RoomSees): void;
  /** The connectors on in a space (the connectors panel's list): ids. */
  listSpaceConnectors(bindingId: string): Promise<Result<string[], Failure>>;
  /** The connectors panel's add / remove (owner or editor; the relay refuses a viewer). */
  addSpaceConnector(bindingId: string, connectorId: string): Promise<Result<void, Failure>>;
  removeSpaceConnector(bindingId: string, connectorId: string): Promise<Result<void, Failure>>;
  /** Takes the owner's fresh approval of this session's always-ask call (`ownerApprovals`): true once, when they just allowed it. */
  takeOwnerApproval(scope: RigToolScope): boolean;
  /** Puts an emoji on a message as the session's agent (the owner's own agent, "Maya's Claude"); answers with the message's reactions. */
  react(bindingId: string, messageId: string, emoji: string, agent: SessionAgent): Promise<Result<MessageReaction[], Failure>>;
  /** The run the session is on right now (per-turn limits); null when unknown. */
  currentRunId(scope: RigToolScope): Promise<string | null>;
  /** A reaction the run made, so its card can show it when the turn ends without words. */
  noteReaction?(runId: string, emoji: string): Promise<void>;
}

export type RigToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };

/** `text` for the agent; `content`, when set, replaces it (a screenshot plus its caption). */
export type RigToolResult = { text: string; isError?: boolean; content?: RigToolContent[] };

export type RigTool = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** When set, any argument outside `inputSchema` is refused with this message instead of being dropped. */
  unknownArgs?: string;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  run: (scope: RigToolScope, input: Record<string, unknown>) => Promise<RigToolResult>;
};

const RECENT_FILES_MAX = 25;
/** A space name is a one-line label (the `# name` in the bar and the Home rail). */
export const SPACE_NAME_MAX = 80;
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

const CHAT_TAIL_DEFAULT = 30;
const CHAT_TAIL_MAX = 200;
/** The relay's largest page of messages (it caps `latest` and `limit` at 500); also how many one `query` searches. */
const RELAY_PAGE = 500;
/** Roughly the most one rig_chat_read call returns, so a long chat never floods the agent's context. */
export const CHAT_HISTORY_MAX_CHARS = 40_000;
/** Relay requests one call may make paging back through a long chat. */
const CHAT_MAX_REQUESTS = 20;
/** Run answers read at once (each is a run-log fetch). */
const ANSWER_BATCH = 8;

/** "Claude" for the agent names runs and agent-written messages carry. */
function agentName(agent: unknown): string {
  if (agent === 'claude' || agent === 'claude-code') return 'Claude';
  if (agent === 'codex') return 'Codex';
  return typeof agent === 'string' && agent ? agent : 'agent';
}

/**
 * Up to `count` chat rows before seq `before` (or the newest), oldest first,
 * and whether older ones may exist. The relay only gives the newest N
 * (`latest`) or pages forward (`after`), and seqs are shared by every space,
 * so rows older than its newest page are found by walking forward from
 * ever-earlier seqs.
 */
async function chatWindow(
  backend: RigToolsBackend,
  bindingId: string,
  before: number | undefined,
  count: number
): Promise<Result<{ rows: RoomMessageRow[]; older: boolean }, Failure>> {
  const latest = await backend.listMessages(bindingId, { latest: before === undefined ? count : RELAY_PAGE });
  if (!latest.success) return latest;
  if (before === undefined) return ok({ rows: latest.data, older: latest.data.length >= count });
  const below = latest.data.filter((row) => row.seq < before);
  const whole = latest.data.length < RELAY_PAGE;
  if (whole || below.length >= count) return ok({ rows: below.slice(-count), older: !whole || below.length > count });

  let requests = 1;
  let span = 2 * Math.max(1_000, before - latest.data[0]!.seq);
  while (requests < CHAT_MAX_REQUESTS) {
    const from = Math.max(0, before - span);
    const rows: RoomMessageRow[] = [];
    let dropped = false;
    let after = from;
    let reached = false;
    while (!reached && requests < CHAT_MAX_REQUESTS) {
      const page = await backend.listMessages(bindingId, { after: String(after), limit: RELAY_PAGE });
      requests += 1;
      if (!page.success) return page;
      for (const row of page.data) {
        if (row.seq >= before) {
          reached = true;
          break;
        }
        rows.push(row);
      }
      if (rows.length > count) {
        rows.splice(0, rows.length - count);
        dropped = true;
      }
      if (page.data.length < RELAY_PAGE) reached = true;
      else after = page.data.at(-1)!.seq;
    }
    if (!reached) break;
    if (rows.length >= count || from === 0) return ok({ rows, older: dropped || from > 0 });
    span *= 4;
  }
  return err({ message: `the chat before #${before} is too long to page back through in one call` });
}

/** What each "chat sees" level shows other members, narrowest first (`ROOM_SEES_LEVELS`). */
const CHAT_SEES_MEANING: Record<RoomSees, string> = {
  answer: 'only your final reply',
  steps: 'your steps, not what your tools returned',
  everything: 'every step and result',
};

const UPDATE_SETTINGS_KEYS: ReadonlySet<string> = new Set(['model', 'effort', 'chat_sees', 'connectors']);

const SETTINGS_OUT_OF_SCOPE =
  "rig_settings_update only changes model, effort, chat_sees and connectors. Permissions mode and \"Auto-approve agent actions\" are your owner's to change themselves, in the agent's settings.";

const NEEDS_OWNER_APPROVAL =
  "Raising chat sees or turning a connector on or off needs your owner's approval every time, and they didn't just approve this call (their permission settings may skip asking). Ask them to allow it when prompted, or to change it themselves in the space panel.";

export type SettingsChange = {
  model?: string;
  effort?: string;
  chat_sees?: RoomSees;
  connectors?: { enable?: readonly string[]; disable?: readonly string[] };
};

/**
 * The parts of a settings change that widen who sees or reaches what (chat
 * sees raised, a connector turned on): these always need the owner's own
 * approval, however the agent's permissions are set. Empty for a change that
 * only narrows, or only touches model and effort.
 */
export function wideningParts(change: SettingsChange, current: { chatSees: RoomSees; connectors: readonly string[] }): string[] {
  const parts: string[] = [];
  if (change.chat_sees && ROOM_SEES_LEVELS.indexOf(change.chat_sees) > ROOM_SEES_LEVELS.indexOf(current.chatSees)) {
    parts.push(`chat sees ${current.chatSees} → ${change.chat_sees}`);
  }
  for (const id of change.connectors?.enable ?? []) {
    if (!current.connectors.includes(id)) parts.push(`turn on ${connectorById(id)?.name ?? id}`);
  }
  return parts;
}

function optionName(option: { id: string; name: string }): string {
  return option.name && option.name !== option.id ? `${option.id} (${option.name})` : option.id;
}

function selectedName(group: AgentConfigChoice | null): string {
  const option = group?.options.find((o) => o.id === group.selected);
  return option ? optionName(option) : (group?.selected ?? 'not set');
}

/** A choice's id from what the agent gave: its id, or its id or name in any case. */
function pickOption(group: AgentConfigChoice, value: string): string | null {
  const exact = group.options.find((o) => o.id === value);
  if (exact) return exact.id;
  const lower = value.toLowerCase();
  return group.options.find((o) => o.id.toLowerCase() === lower || o.name.toLowerCase() === lower)?.id ?? null;
}

/** What a query matches: a message's text, and a file comment's file and passage. */
function chatHaystack(row: RoomMessageRow): string {
  const meta = row.meta ?? {};
  return [row.body, row.path ?? meta.path, row.quote ?? meta.quote].filter((s) => typeof s === 'string').join('\n').toLowerCase();
}

/**
 * A message the agent names: its #seq (as rig_chat_read shows it) or its
 * id. Seqs are shared by every space, so a seq is looked up in this space's
 * own chat.
 */
async function messageIdFor(backend: RigToolsBackend, bindingId: string, value: unknown): Promise<Result<string, string>> {
  const raw = String(value ?? '').trim();
  const bySeq = /^#?(\d+)$/.exec(raw);
  if (bySeq) {
    const seq = Number(bySeq[1]);
    const page = await backend.listMessages(bindingId, { after: String(seq - 1), limit: 1 });
    if (!page.success) return err(`Couldn't find message #${seq}: ${page.error.message}`);
    const row = page.data[0];
    return row && row.seq === seq ? ok(row.id) : err(`There's no message #${seq} in this space's chat.`);
  }
  if (/^msg_[A-Za-z0-9]+$/.test(raw)) return ok(raw);
  return err(`"${raw}" isn't a message: give its #seq (from rig_chat_read) or its id.`);
}

/** `[rig].name` and `[rig].description` from a space's `rig.toml` text; null for each one missing or empty. */
export function parseSpaceManifest(raw: string | null): { name: string | null; description: string | null } {
  if (!raw) return { name: null, description: null };
  try {
    const rig = toml.parse(raw).rig as Record<string, unknown> | undefined;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? oneLine(value) : null);
    return { name: text(rig?.name), description: text(rig?.description) };
  } catch {
    return { name: null, description: null };
  }
}

/** A space name as members see it: `#launch-plan`. */
export function spaceLabel(name: string): string {
  return name.startsWith('#') ? name : `#${name}`;
}

/** How many files, skills and characters rig_space_describe shows at most. */
export const DESCRIBE_FILES_MAX = 60;
export const DESCRIBE_SKILLS_MAX = 30;
const DESCRIBE_PEOPLE_MAX = 40;
const DESCRIBE_SKILL_CHARS = 160;
const DESCRIBE_TOOL_CHARS = 160;
export const DESCRIBE_MAX_CHARS = 8_000;

const SKILL_FILE = /^(\.claude|\.agents)\/skills\/([^/]+)\/SKILL\.md$/;

export type SpaceSkill = { name: string; description: string; dirs: string[] };

/** The skills under `.claude/skills` and `.agents/skills`, one per skill folder name, sorted by name. */
export function dedupeSkills(found: ReadonlyArray<{ dir: string; folder: string; skillMd: string | null }>): SpaceSkill[] {
  const byFolder = new Map<string, SpaceSkill>();
  for (const { dir, folder, skillMd } of found) {
    const entry = byFolder.get(folder) ?? { name: folder, description: '', dirs: [] };
    if (!entry.dirs.includes(dir)) entry.dirs.push(dir);
    if (!entry.description && skillMd) entry.description = oneLine(parseFrontmatter(skillMd).frontmatter.description ?? '');
    byFolder.set(folder, entry);
  }
  return [...byFolder.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Files every member gets: none under a dot folder (`.rig`, `.claude`, `.git`), none sync skips, none named like a secret. */
export function sharedFiles(nodes: readonly RigFileNode[], isSyncIgnored: (relPath: string) => boolean): RigFileNode[] {
  return flattenFiles(nodes).filter(
    (f) => !f.relPath.split('/').some((part) => part.startsWith('.')) && !isSyncIgnored(f.relPath) && !secretReason(f.name, null)
  );
}

/** A tool description's first sentence, for a one-line listing. */
function firstSentence(text: string): string {
  const flat = oneLine(text);
  const match = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  const sentence = match ? match[1]! : flat;
  return sentence.length > DESCRIBE_TOOL_CHARS ? `${sentence.slice(0, DESCRIBE_TOOL_CHARS - 1)}…` : sentence;
}

export type SpaceOverview = {
  name: string | null;
  description: string | null;
  /** Members by name and role; `you` marks the session's owner. Never emails. */
  people: Array<{ name: string | null; role: string; you: boolean }> | { error: string };
  /** Shared files (see `sharedFiles`), any order. */
  files: ReadonlyArray<{ relPath: string; mtimeMs?: number }> | { error: string };
  skills: SpaceSkill[];
  /** Connector ids on in the space; `reachable` as the session's scope has it, when known. */
  connectors: { on: readonly string[]; reachable?: RigToolScope['reachable'] } | { error: string };
  /** Servers the space's own `.mcp.json` declares. */
  projectServers: readonly string[];
  tools: ReadonlyArray<{ name: string; description: string }>;
};

/** rig_space_describe's text: a few KB at most, whatever the space holds. */
export function formatSpaceOverview(o: SpaceOverview, now: number): string {
  const lines: string[] = [o.name ? `Space: ${spaceLabel(o.name)}` : 'Space: (no name yet)'];
  if (o.description) lines.push(`About: ${o.description}`);

  if ('error' in o.people) {
    lines.push('', `People: couldn't load them (${o.people.error}).`);
  } else {
    const nameOf = (p: { name: string | null }) => p.name ?? 'a member with no name set';
    const owner = o.people.find((p) => p.role === 'owner');
    if (owner) lines.push(`Owner: ${nameOf(owner)}${owner.you ? ' (your owner)' : ''}`);
    lines.push('', `People (${o.people.length}):`);
    for (const p of o.people.slice(0, DESCRIBE_PEOPLE_MAX)) lines.push(`- ${nameOf(p)}: ${p.role}${p.you ? ' (your owner)' : ''}`);
    if (o.people.length > DESCRIBE_PEOPLE_MAX) lines.push(`- …and ${o.people.length - DESCRIBE_PEOPLE_MAX} more`);
    lines.push('rig_people_list also lists pending invites.');
  }

  lines.push('');
  if ('error' in o.files) {
    lines.push(`Files: couldn't read them (${o.files.error}).`);
  } else if (o.files.length === 0) {
    lines.push('Files: none yet.');
  } else {
    const sorted = [...o.files].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
    const shown = sorted.slice(0, DESCRIBE_FILES_MAX);
    lines.push(`Files (${sorted.length}, most recently changed first, paths relative to the space's folder):`);
    for (const f of shown) lines.push(`- ${f.relPath}${f.mtimeMs ? ` (${ago(f.mtimeMs, now)})` : ''}`);
    if (sorted.length > shown.length) lines.push(`- …and ${sorted.length - shown.length} more`);
  }

  lines.push('');
  if (o.skills.length === 0) {
    lines.push('Skills: none in .claude/skills or .agents/skills.');
  } else {
    lines.push(`Skills (${o.skills.length}):`);
    for (const s of o.skills.slice(0, DESCRIBE_SKILLS_MAX)) {
      const about = s.description.length > DESCRIBE_SKILL_CHARS ? `${s.description.slice(0, DESCRIBE_SKILL_CHARS - 1)}…` : s.description;
      lines.push(`- ${s.name} (${s.dirs.join(', ')}): ${about || 'no description'}`);
    }
    if (o.skills.length > DESCRIBE_SKILLS_MAX) lines.push(`- …and ${o.skills.length - DESCRIBE_SKILLS_MAX} more`);
  }

  lines.push('');
  const name = (id: string) => connectorById(id)?.name ?? id;
  if ('error' in o.connectors) {
    lines.push(`Connectors: couldn't read them (${o.connectors.error}).`);
  } else {
    const { on, reachable } = o.connectors;
    if (on.length === 0) {
      lines.push('Connectors on in this space: none.');
    } else {
      const label = (id: string) =>
        !reachable ? name(id) : `${name(id)} (${reachable.connectors.includes(id) ? 'you have it' : "you don't have it this session"})`;
      lines.push(`Connectors on in this space: ${on.map(label).join(', ')}. Each member uses their own login.`);
    }
    const global = reachable?.global.filter((id) => !on.includes(id)) ?? [];
    if (global.length > 0) lines.push(`Your owner's own setup also gives you: ${global.map(name).join(', ')}.`);
  }
  if (o.projectServers.length > 0) lines.push(`MCP servers this space's .mcp.json declares: ${o.projectServers.join(', ')}.`);

  // Always whole, at the end: anything cut to fit comes out of the sections above.
  const toolLines = ['', "Rig's own tools (use them instead of the rig CLI):", ...o.tools.map((t) => `- ${t.name}: ${firstSentence(t.description)}`)];
  const tools = toolLines.join('\n');
  const rest = lines.join('\n');
  const room = DESCRIBE_MAX_CHARS - tools.length;
  if (rest.length <= room) return `${rest}\n${tools}`;
  const cut = rest.slice(0, Math.max(0, room)).replace(/\n[^\n]*$/, '');
  return `${cut}\n…(cut to keep this short)\n${tools}`;
}

/** The server names in a `.mcp.json` text, or none when it's missing or isn't JSON. */
function mcpJsonServers(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const servers = (JSON.parse(raw) as { mcpServers?: unknown }).mcpServers;
    return servers && typeof servers === 'object' ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

/**
 * rig_space_describe's inputs, read as the session's owner: the manifest,
 * members, the folder listing (sync rules from `.tapignore`), each skill's
 * SKILL.md and the space's connectors.
 */
async function spaceOverview(
  backend: RigToolsBackend,
  scope: RigToolScope,
  tools: readonly RigTool[]
): Promise<SpaceOverview> {
  const [manifest, tapignore, mcpJson, members, files, connectors] = await Promise.all([
    backend.readText(scope.cwd, 'rig.toml').catch(() => null),
    backend.readText(scope.cwd, '.tapignore').catch(() => null),
    backend.readText(scope.cwd, '.mcp.json').catch(() => null),
    backend.listMembers(scope.bindingId),
    backend.listFiles(scope.cwd),
    backend.listSpaceConnectors(scope.bindingId),
  ]);
  const found: Array<{ dir: string; folder: string; relPath: string }> = [];
  if (files.success) {
    for (const f of flattenFiles(files.data)) {
      const match = SKILL_FILE.exec(f.relPath);
      if (match) found.push({ dir: `${match[1]}/skills`, folder: match[2]!, relPath: f.relPath });
    }
  }
  const skillMds = await Promise.all(found.map((s) => backend.readText(scope.cwd, s.relPath).catch(() => null)));
  return {
    ...parseSpaceManifest(manifest),
    people: members.success
      ? members.data.map((m) => ({ name: m.name, role: m.role, you: m.userId === scope.ownerUserId }))
      : { error: members.error.message },
    files: files.success ? sharedFiles(files.data, syncIgnoreMatcher(tapignore)) : { error: files.error.message },
    skills: dedupeSkills(found.map((s, i) => ({ dir: s.dir, folder: s.folder, skillMd: skillMds[i] ?? null }))),
    connectors: connectors.success
      ? { on: connectors.data.filter(isConnectorId), ...(scope.reachable ? { reachable: scope.reachable } : {}) }
      : { error: connectors.error.message },
    projectServers: mcpJsonServers(mcpJson),
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
  };
}

/**
 * `allTools`: every tool the session's `rig` server offers (these and the
 * browser tools), for rig_space_describe's list; omitted, just these.
 */
/** How many of your people rig_people_list lists, most recent first. */
const PEOPLE_LISTED = 30;

/**
 * `rig_people_invite`'s person path: find them in your people by id, by full name,
 * or by a first name only one of them has, and send a person invite. An
 * ambiguous or unknown name fails with what to do, never a guess.
 */
async function invitePerson(
  backend: RigToolsBackend,
  bindingId: string,
  asked: string,
  role: RigInviteRole
): Promise<RigToolResult> {
  if (!backend.listPeople || !backend.invitePerson) {
    return failed("This version of Rig can't invite by name yet. Ask for their email and pass `email`.");
  }
  const listed = await backend.listPeople();
  if (!listed.success) return failed(`Couldn't load your owner's people: ${listed.error.message}`);
  if (!listed.data.supported) return failed("This Rig server can't invite by name yet. Ask for their email and pass `email`.");
  const key = asked.replace(/^@/, '').trim().toLowerCase();
  const people = listed.data.people.filter((p) => p.name);
  let hits = people.filter((p) => p.userId.toLowerCase() === key || p.name!.trim().toLowerCase() === key);
  if (hits.length === 0) hits = people.filter((p) => p.name!.trim().toLowerCase().split(/\s+/)[0] === key);
  if (hits.length > 1) {
    return failed(`More than one person matches "${asked}": ${hits.map((p) => `${p.name} (id ${p.userId})`).join(', ')}. Pass the id.`);
  }
  const person = hits[0];
  if (!person) {
    return failed(`"${asked}" isn't among the people your owner has worked with. Ask your owner for their email and pass \`email\`. Don't look an address up elsewhere.`);
  }
  const minted = await backend.invitePerson(bindingId, person.userId, role);
  if (!minted.success) return failed(`Couldn't invite ${person.name}: ${minted.error.message}`);
  const sent = minted.data.email;
  return {
    text: [
      `Invited ${person.name} to this space as ${role}. They'll see it in Rig${sent.sent ? ' and by email' : ''}.`,
      `Join link (only ${person.name} can use it): ${minted.data.url}`,
    ].join('\n'),
  };
}

export function createRigTools(
  backend: RigToolsBackend,
  now: () => number = Date.now,
  allTools?: () => readonly RigTool[]
): RigTool[] {
  /** Reactions each session has added on its current run (`MAX_REACTIONS_PER_RUN`). */
  const reactionsByScope = new Map<string, { runId: string | null; count: number }>();
  const tools: RigTool[] = [
    {
      name: 'rig_space_describe',
      description:
        "Describe this rig space: its name, owner and people, its files (newest first), its skills, its connectors and rig's own tools. " +
        "Use it when asked what's here, what this space is for or what you can do in it, and before looking around the folder by hand.",
      inputSchema: {},
      annotations: { title: "What's in this space", readOnlyHint: true },
      run: async (scope) => ({ text: formatSpaceOverview(await spaceOverview(backend, scope, (allTools ?? (() => tools))()), now()) }),
    },
    {
      name: 'rig_people_invite',
      description:
        "Invite a person to this rig space. Use it whenever you're asked to invite, add or share the space with someone, instead of running `rig share`: the request is the go-ahead. " +
        "For someone your owner has worked with, pass `person`: their name or id as rig_people_list lists them. They hear about it in Rig and by email, and nobody needs their address. " +
        'For anyone else pass `email`, the address you were given. Never look an address up elsewhere, such as Slack, a directory or old messages: if the person isn\'t in rig_people_list and you weren\'t given an email, ask for one. ' +
        'Asked for an invite link without anyone named, pass `link: true`: anyone with that link can join, so make one only when asked for a link. ' +
        'role is editor (can edit files and ask their own agents; the default) or viewer (read-only). ' +
        "Owners and editors can invite; if your owner can't, the result says so." + "\nWas called rig_invite before Rig 0.4.13.",
      inputSchema: {
        person: z.string().optional().describe("Someone from your owner's people: their name as rig_people_list lists it, or their id."),
        email: z.string().optional().describe("An email address you were given, for someone who isn't in your owner's people."),
        link: z.boolean().optional().describe('true for an open invite link anyone can join with, when asked for a link and no one is named.'),
        role: z.enum(['editor', 'viewer']).optional().describe('editor (default) or viewer.'),
      },
      annotations: { title: 'Invite to this space', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      run: async (scope, input) => {
        const role: RigInviteRole = input.role === 'viewer' ? 'viewer' : 'editor';
        if (backend.bindingAt(scope.cwd) !== scope.bindingId) {
          return failed("This space's folder on this device isn't linked to the space any more, so no invite was sent.");
        }
        const asked = String(input.person ?? '').trim();
        if (asked) return invitePerson(backend, scope.bindingId, asked, role);
        const email = String(input.email ?? '').trim();
        if (!email && input.link === true) {
          const minted = await backend.createInvite(scope.cwd, null, role);
          if (!minted.success) return failed(`Couldn't make an invite link: ${minted.error.message}`);
          return { text: [`Invite link to this space, as ${role}. Anyone with it can join.`, minted.data.url].join('\n') };
        }
        if (!email) return failed('Say who to invite: `person` for someone in rig_people_list, or `email`. For an open link, pass `link: true`.');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return failed(`"${email}" doesn't look like an email address.`);
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
      name: 'rig_people_list',
      description:
        "List who is in this rig space (name and role) and the invites still waiting to be accepted, then your owner's people who aren't in it yet: everyone they've shared a space with, by name and id, ready for rig_people_invite's `person`. " +
        "Use it when asked who has access or who's here, and before inviting anyone." + "\nWas called rig_people before Rig 0.4.13.",
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
        const people = backend.listPeople ? await backend.listPeople() : null;
        if (people?.success && people.data.supported) {
          const here = new Set(members.data.map((m) => m.userId));
          const others = people.data.people.filter((p) => p.name && !here.has(p.userId)).slice(0, PEOPLE_LISTED);
          lines.push('', others.length > 0 ? `Your owner's people, not in this space (${others.length}):` : "Your owner's people are all in this space.");
          for (const p of others) lines.push(`- ${p.name} (id ${p.userId})`);
        }
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'rig_changes_list',
      description:
        "List the files changed recently in this rig space and who did what: files changed in the last `hours` (default 24), newest first, and rig's one-line summary of who (people and their agents) did what. " +
        "Use it when asked what's new, what changed, or what people have been working on. For one file's full history, use `rig history <path>`." + "\nWas called rig_recent_changes before Rig 0.4.13.",
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
      name: 'rig_chat_read',
      description:
        "Read this space's chat history in full: messages from people and agents (with each agent's reply), file comments and joins, oldest first, each with its #seq, time, author and kind, and its reactions as counts. " +
        'Use it whenever you need chat older than the recent messages in your context, a message in full, or to find what someone said, instead of `rig chat`. ' +
        `tail is how many messages (default ${CHAT_TAIL_DEFAULT}, max ${CHAT_TAIL_MAX}); before_seq pages back (pass the oldest #seq you have). ` +
        `query keeps only messages whose text, file or quoted passage contains it (any case; agents' replies aren't searched), within the ${RELAY_PAGE} messages before before_seq.` + "\nWas called rig_chat_history before Rig 0.4.13.",
      inputSchema: {
        tail: z.number().int().min(1).max(CHAT_TAIL_MAX).optional().describe(`How many messages, newest last (default ${CHAT_TAIL_DEFAULT}).`),
        before_seq: z.number().int().min(1).optional().describe('Only messages before this #seq, to page back.'),
        query: z.string().optional().describe('Text to search for (case-insensitive).'),
      },
      annotations: { title: "This space's chat", readOnlyHint: true },
      run: async (scope, input) => {
        const tail = typeof input.tail === 'number' ? input.tail : CHAT_TAIL_DEFAULT;
        const before = typeof input.before_seq === 'number' ? input.before_seq : undefined;
        const rawQuery = typeof input.query === 'string' ? input.query.trim() : '';
        const query = rawQuery.toLowerCase();
        const [members, fetched] = await Promise.all([
          backend.listMembers(scope.bindingId),
          chatWindow(backend, scope.bindingId, before, query ? RELAY_PAGE : tail),
        ]);
        if (!fetched.success) return failed(`Couldn't load the space's chat: ${fetched.error.message}`);
        const rows = fetched.data.rows;

        // Message authors carry a Clerk id; members carry both ids (the Room's own mapping).
        const names = new Map<string, string>();
        for (const m of members.success ? members.data : []) {
          const name = m.name ?? m.email?.split('@')[0] ?? 'someone';
          names.set(m.userId, name);
          if (m.clerkUserId) names.set(m.clerkUserId, name);
        }
        const byId = new Map(rows.map((row) => [row.id, row]));
        const matches = query ? rows.filter((row) => chatHaystack(row).includes(query)) : rows;
        const selected = matches.slice(-tail);

        const entry = async (row: RoomMessageRow): Promise<string | null> => {
          const text = await entryText(row);
          // Counts only, never who: a reaction can't carry anyone's words here.
          const label = reactionsLabel(row.reactions);
          return text !== null && label ? `${text}\n${label}` : text;
        };
        const entryText = async (row: RoomMessageRow): Promise<string | null> => {
          const meta = row.meta ?? {};
          const person = names.get(row.author.userId ?? '') ?? row.author.name ?? 'someone';
          const by = row.author.kind === 'agent' ? `${person}'s ${agentName(meta.agent)}` : person;
          const head = (at: string, who: string, kind: string) => `#${row.seq} · ${at} · ${who} · ${kind}`;
          if (row.kind === 'session') {
            const runId = typeof meta.runId === 'string' ? meta.runId : null;
            const run = runId ? await backend.runAnswer(scope.bindingId, runId).catch(() => null) : null;
            const agent = `${person}'s ${agentName(run?.agent)}`;
            const ask = `${head(row.createdAt, person, `asked ${agent}`)}\n${row.body}`;
            return run?.text ? `${ask}\n\n${head(run.endedAt ?? row.createdAt, agent, 'reply')}\n${run.text}` : ask;
          }
          if (!row.body) return null; // deleted
          const parent = row.parentId ? byId.get(row.parentId) : undefined;
          // Doc comments share the chat (as in the Room): a reply carries no path, its thread's root does.
          const path = row.path ?? (typeof meta.path === 'string' ? meta.path : null) ?? parent?.path ?? null;
          if (path || row.kind === 'comment_mirror') {
            const on = path ? ` on ${path}` : '';
            const quote = row.quote ?? (typeof meta.quote === 'string' ? meta.quote : null);
            const text = row.parentId
              ? `replied${on} — ${row.body}`
              : `commented${on}${quote ? `: “${oneLine(quote).slice(0, 200)}”` : ''} — ${row.body}`;
            return `${head(row.createdAt, by, 'comment')}\n${text}`;
          }
          return `${head(row.createdAt, by, row.kind === 'text' ? 'message' : row.kind)}\n${row.body}`;
        };

        // Newest first until the budget runs out, so a cut always drops the oldest.
        const blocks: string[] = [];
        let used = 0;
        let oldestShown: number | null = null;
        let cut = false;
        for (let end = selected.length; end > 0 && !cut; end -= ANSWER_BATCH) {
          const batch = selected.slice(Math.max(0, end - ANSWER_BATCH), end).reverse();
          const rendered = await Promise.all(batch.map(entry));
          for (const [i, block] of rendered.entries()) {
            if (block === null) continue;
            if (used + block.length > CHAT_HISTORY_MAX_CHARS) {
              if (blocks.length === 0) {
                blocks.push(`${block.slice(0, CHAT_HISTORY_MAX_CHARS)}\n…(cut: this message is too long to show in full)`);
                oldestShown = batch[i]!.seq;
              }
              cut = true;
              break;
            }
            blocks.push(block);
            used += block.length + 2;
            oldestShown = batch[i]!.seq;
          }
        }
        blocks.reverse();

        const hidden = cut || matches.length > selected.length;
        const older = fetched.data.older || hidden;
        const nextBefore = hidden ? oldestShown : (rows[0]?.seq ?? null);
        const lines: string[] = [];
        if (query) {
          const searched = rows.length > 0 ? ` (#${rows[0]!.seq}–#${rows.at(-1)!.seq})` : '';
          lines.push(
            blocks.length === 0
              ? `No messages matching "${rawQuery}" in the ${rows.length} messages searched${searched}.`
              : `${matches.length} of the ${rows.length} messages searched${searched} match "${rawQuery}"; ${blocks.length} shown, oldest first:`
          );
        } else if (blocks.length === 0) {
          lines.push(before === undefined ? "No messages in this space's chat yet." : `No messages before #${before}.`);
        } else {
          lines.push(`This space's chat, oldest first (${blocks.length} ${blocks.length === 1 ? 'message' : 'messages'}):`);
        }
        if (blocks.length > 0) lines.push('', blocks.join('\n\n'));
        if (cut) lines.push('', `(Stopped at about ${CHAT_HISTORY_MAX_CHARS / 1000}k characters.)`);
        if (older && nextBefore !== null) {
          lines.push('', `${query ? 'To search' : 'For'} older messages, call rig_chat_read with before_seq=${nextBefore}.`);
        } else if (rows.length > 0) {
          lines.push('', "That's the start of the chat.");
        }
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'rig_chat_react',
      description:
        "Acknowledge, vote or agree without words. Puts one emoji on a message in this space's chat, as your owner's agent. " +
        'Use it whenever a reaction says enough: 👍 or 👀 to acknowledge, a vote or a pick when asked, ✅ to mark a request done. ' +
        'A reaction can be the whole answer to a message that only needs one: then end your turn without a reply. ' +
        `Reacting doesn't trigger or notify any agent. Up to ${MAX_REACTIONS_PER_RUN} per turn. ` +
        "messageId is the message's number, like #42, as your context or rig_chat_read shows it, or its id. emoji is the emoji itself, like 👍, not its name." + "\nWas called rig_react before Rig 0.4.13.",
      inputSchema: {
        messageId: z.string().describe('The message: its #seq (e.g. "#42") or its id.'),
        emoji: z.string().describe('One emoji, e.g. 👍 ✅ 👀 🎉.'),
      },
      annotations: { title: 'React to a message', readOnlyHint: false, destructiveHint: false },
      run: async (scope, input) => {
        const emoji = canonicalEmoji(String(input.emoji ?? ''));
        if (!emoji) return failed(`"${String(input.emoji ?? '')}" isn't a single emoji. Give the emoji itself, like 👍.`);
        const key = rigToolScopeKey(scope);
        const runId = await backend.currentRunId(scope).catch(() => null);
        const used = reactionsByScope.get(key);
        const tally = used && used.runId === runId ? used : { runId, count: 0 };
        if (tally.count >= MAX_REACTIONS_PER_RUN) {
          return failed(
            `You've already reacted ${MAX_REACTIONS_PER_RUN} times this turn, the most one turn can. Say the rest in your reply instead.`
          );
        }
        // Counted before the call, so reactions made at once can't overshoot; a failed one is given back.
        tally.count += 1;
        reactionsByScope.set(key, tally);
        const giveBack = () => {
          tally.count -= 1;
        };
        const messageId = await messageIdFor(backend, scope.bindingId, input.messageId);
        if (!messageId.success) {
          giveBack();
          return failed(messageId.error);
        }
        const reacted = await backend.react(scope.bindingId, messageId.data, emoji, scope.agent);
        if (!reacted.success) {
          giveBack();
          return failed(`Couldn't react: ${reacted.error.message}`);
        }
        // The run's card says "Claude reacted 👍" when that's all the turn did.
        if (runId && backend.noteReaction) await backend.noteReaction(runId, emoji).catch(() => {});
        const counts = reactionCounts(reacted.data);
        return { text: `Reacted ${emoji}.${counts ? ` The message's reactions: ${counts}.` : ''}` };
      },
    },
    {
      name: 'rig_comments_read',
      description:
        "Read the comment threads on a file in this rig space: each thread's id, the passage it's pinned to, and who said what (people and agents). " +
        'Use it when asked about comments, feedback or open questions on a file, and before replying with rig_comments_add. ' +
        "path is relative to the space's folder. Resolved threads are left out unless include_resolved is true." + "\nWas called rig_file_comments before Rig 0.4.13.",
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
      name: 'rig_comments_add',
      description:
        'Add a comment on a file in this rig space, or reply to a thread on it. Everyone in the space sees it, marked as written by you (the agent) for your owner. ' +
        'New thread: give quote, a passage copied exactly from the file, which the comment is pinned to. ' +
        'Reply: give reply_to, a thread id from rig_comments_read, and no quote. ' +
        'Use it when asked to comment on, annotate or review a file, or to answer feedback on it, instead of `rig comment`.' + "\nWas called rig_comment before Rig 0.4.13.",
      inputSchema: {
        path: z.string().describe("The file, relative to the space's folder, e.g. notes/plan.md."),
        body: z.string().describe('The comment, in markdown.'),
        quote: z.string().optional().describe('For a new thread: the exact passage from the file to pin it to.'),
        reply_to: z.string().optional().describe('For a reply: the thread id (from rig_comments_read).'),
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
    {
      name: 'rig_space_rename',
      description:
        "Rename this rig space: the new name shows for everyone in it. Use it whenever you're asked to rename the space (or give it a name), instead of editing rig.toml yourself: the request is the go-ahead. " +
        `name is the new name, one line, up to ${SPACE_NAME_MAX} characters. ` +
        'Owners and editors can rename; if your owner is a viewer, the result says so.' + "\nWas called rig_rename_space before Rig 0.4.13.",
      inputSchema: {
        name: z.string().describe(`The new name, e.g. Launch planning (up to ${SPACE_NAME_MAX} characters).`),
      },
      annotations: { title: 'Rename this space', readOnlyHint: false, destructiveHint: false },
      run: async (scope, input) => {
        const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
        if (!name) return failed('The space needs a name: give some text.');
        if (name.length > SPACE_NAME_MAX) {
          return failed(`That name is ${name.length} characters; keep it to ${SPACE_NAME_MAX} or fewer.`);
        }
        if (backend.bindingAt(scope.cwd) !== scope.bindingId) {
          return failed("This space's folder on this device isn't linked to the space any more, so it wasn't renamed.");
        }
        // Renaming edits the space's shared rig.toml, so it takes edit rights: a viewer can't.
        const members = await backend.listMembers(scope.bindingId);
        if (!members.success) return failed(`Couldn't check your owner's role in this space, so it wasn't renamed: ${members.error.message}`);
        const role = members.data.find((m) => m.userId === scope.ownerUserId)?.role;
        if (!role) return failed("Your owner isn't a member of this space any more, so it wasn't renamed.");
        if (role === 'viewer') {
          return failed("Your owner is a viewer in this space, so they can't rename it. Ask an owner or editor to.");
        }
        const renamed = await backend.renameSpace(scope.bindingId, scope.cwd, name);
        if (!renamed.success) return failed(`Couldn't rename the space: ${renamed.error.message}`);
        return { text: `Renamed this space to "${renamed.data.name}". Everyone in it will see the new name.` };
      },
    },
    {
      name: 'rig_settings_read',
      description:
        "Read your own agent settings in this space: model, effort, permissions, how much of your work the chat sees, and the space's connectors, with the valid choices for each. " +
        'Use it when asked about your settings, and before changing them with rig_settings_update.' + "\nWas called rig_settings before Rig 0.4.13.",
      inputSchema: {},
      annotations: { title: 'Your settings in this space', readOnlyHint: true },
      run: async (scope) => {
        const [config, connectors] = await Promise.all([backend.agentConfig(scope), backend.listSpaceConnectors(scope.bindingId)]);
        const chatSees = backend.roomSees(scope.bindingId);
        const lines = [`Your owner's ${agentName(scope.agent)} in this space (only yours: other members' agents have their own settings):`];
        if (config.success) {
          for (const [label, group] of [['Model', config.data.model], ['Effort', config.data.effort]] as const) {
            lines.push(group ? `- ${label}: ${selectedName(group)}; choices: ${group.options.map(optionName).join(', ')}` : `- ${label}: not offered by this agent`);
          }
          if (config.data.mode) lines.push(`- Permissions: ${selectedName(config.data.mode)} (your owner changes this themselves, in the space panel)`);
        } else {
          lines.push(`- Model, effort, permissions: couldn't read them (${config.error.message})`);
        }
        lines.push(
          `- Chat sees: ${chatSees}, ${CHAT_SEES_MEANING[chatSees]}; choices: ${ROOM_SEES_LEVELS.map((level) => `${level} (${CHAT_SEES_MEANING[level]})`).join(', ')}`
        );
        if (connectors.success) {
          const on = connectors.data.filter(isConnectorId);
          lines.push(
            `- Connectors on in this space (the space's, for every member, each with their own login): ${on.length > 0 ? on.map((id) => `${id} (${connectorById(id)!.name})`).join(', ') : 'none'}`,
            `  Others that can be turned on: ${CONNECTORS.filter((c) => !on.includes(c.id)).map((c) => c.id).join(', ')}`
          );
        } else {
          lines.push(`- Connectors: couldn't read them (${connectors.error.message})`);
        }
        lines.push(
          '',
          "Change model, effort, chat sees or connectors with rig_settings_update. Raising chat sees or turning a connector on always needs your owner's approval."
        );
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'rig_settings_update',
      description:
        "Change your own agent settings in this space: model, effort, chat_sees (answer, steps or everything: how much of your work other members see) and the space's connectors (for every member). " +
        'Use it when your owner asks you to change these; rig_settings_read lists the valid values. Give only what changes; the rest stays. ' +
        "Raising chat_sees or turning a connector on always needs your owner's approval. Permissions mode and auto-approve can't be changed here: your owner changes those themselves." + "\nWas called rig_update_settings before Rig 0.4.13.",
      inputSchema: {
        model: z.string().optional().describe('A model id from rig_settings_read.'),
        effort: z.string().optional().describe('An effort id from rig_settings_read.'),
        chat_sees: z.enum(['answer', 'steps', 'everything']).optional().describe('How much of your work other members see.'),
        connectors: z
          .object({
            enable: z.array(z.string()).optional().describe('Connector ids to turn on, e.g. linear.'),
            disable: z.array(z.string()).optional().describe('Connector ids to turn off.'),
          })
          .strict()
          .optional()
          .describe("The space's connectors to turn on or off."),
      },
      unknownArgs: SETTINGS_OUT_OF_SCOPE,
      annotations: { title: 'Change your settings in this space', readOnlyHint: false, destructiveHint: false },
      run: async (scope, input) => {
        const unknown = Object.keys(input).filter((key) => !UPDATE_SETTINGS_KEYS.has(key));
        if (unknown.length > 0) return failed(`Can't change ${unknown.join(', ')}. ${SETTINGS_OUT_OF_SCOPE}`);
        // Taken first, whatever happens next: an approval answers this one call only.
        const approved = backend.takeOwnerApproval(scope);
        const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
        const wanted = { model: text(input.model), effort: text(input.effort) };
        const chatSees = ROOM_SEES_LEVELS.find((level) => level === input.chat_sees);
        const ids = (value: unknown) => [...new Set(Array.isArray(value) ? value.map(text).filter(Boolean) : [])];
        const connectorsInput = (input.connectors ?? {}) as { enable?: unknown; disable?: unknown };
        const enable = ids(connectorsInput.enable);
        const disable = ids(connectorsInput.disable);
        if (!wanted.model && !wanted.effort && !chatSees && enable.length === 0 && disable.length === 0) {
          return failed('Nothing to change: give model, effort, chat_sees or connectors.');
        }
        const unknownIds = [...enable, ...disable].filter((id) => !isConnectorId(id));
        if (unknownIds.length > 0) {
          return failed(`No connector called ${unknownIds.join(', ')}, so nothing changed. rig_settings_read lists the ids (e.g. ${CONNECTORS.slice(0, 3).map((c) => c.id).join(', ')}).`);
        }
        if (enable.some((id) => disable.includes(id))) return failed('A connector is in both enable and disable, so nothing changed.');

        // Model and effort: validated against the agent's own choices before anything changes.
        let config: AgentConfig | null = null;
        const configChange: { model?: string; effort?: string } = {};
        if (wanted.model || wanted.effort) {
          const loaded = await backend.agentConfig(scope);
          if (!loaded.success) return failed(`Couldn't read your settings, so nothing changed: ${loaded.error.message}`);
          config = loaded.data;
          for (const dimension of ['model', 'effort'] as const) {
            const value = wanted[dimension];
            if (!value) continue;
            const group = config[dimension];
            if (!group) return failed(`This agent has no ${dimension} setting, so nothing changed.`);
            const id = pickOption(group, value);
            if (!id) return failed(`"${value}" isn't one of the ${dimension} choices (${group.options.map((o) => o.id).join(', ')}), so nothing changed.`);
            if (id !== group.selected) configChange[dimension] = id;
          }
        }
        let connectorsOn: string[] = [];
        if (enable.length > 0 || disable.length > 0) {
          const listed = await backend.listSpaceConnectors(scope.bindingId);
          if (!listed.success) return failed(`Couldn't read the space's connectors, so nothing changed: ${listed.error.message}`);
          connectorsOn = listed.data;
        }
        const seesBefore = backend.roomSees(scope.bindingId);
        const blocked = !approved && wideningParts({ chat_sees: chatSees, connectors: { enable } }, { chatSees: seesBefore, connectors: connectorsOn }).length > 0;

        const changed: string[] = [];
        const refused: string[] = [];
        if (config && Object.keys(configChange).length > 0) {
          const set = await backend.setAgentConfig(scope, configChange);
          if (!set.success) refused.push(`${Object.keys(configChange).join(' and ')}: ${set.error.message}`);
          else {
            for (const dimension of ['model', 'effort'] as const) {
              if (configChange[dimension]) changed.push(`${dimension}: ${selectedName(config[dimension])} → ${selectedName(set.data[dimension])}`);
            }
          }
        }
        if (chatSees && chatSees !== seesBefore) {
          const widens = ROOM_SEES_LEVELS.indexOf(chatSees) > ROOM_SEES_LEVELS.indexOf(seesBefore);
          if (widens && blocked) refused.push(`chat sees ${seesBefore} → ${chatSees}: needs your owner's approval`);
          else {
            backend.setRoomSees(scope.bindingId, chatSees);
            changed.push(`chat sees: ${seesBefore} → ${chatSees} (${CHAT_SEES_MEANING[chatSees]})`);
          }
        }
        for (const id of enable.filter((id) => !connectorsOn.includes(id))) {
          const name = connectorById(id)!.name;
          if (blocked) {
            refused.push(`turn on ${name}: needs your owner's approval`);
            continue;
          }
          const added = await backend.addSpaceConnector(scope.bindingId, id);
          if (added.success) changed.push(`${name}: turned on in this space`);
          else refused.push(`turn on ${name}: ${added.error.message}`);
        }
        // Turning one off takes it away from everyone in the space, so it needs the owner's own "allow" too.
        let disableBlocked = false;
        for (const id of disable.filter((id) => connectorsOn.includes(id))) {
          const name = connectorById(id)!.name;
          if (!approved) {
            disableBlocked = true;
            refused.push(`turn off ${name}: changes it for everyone in the space, needs your owner's approval`);
            continue;
          }
          const removed = await backend.removeSpaceConnector(scope.bindingId, id);
          if (removed.success) changed.push(`${name}: turned off in this space`);
          else refused.push(`turn off ${name}: ${removed.error.message}`);
        }

        const lines =
          changed.length > 0
            ? ['Changed, from your next turn:', ...changed.map((line) => `- ${line}`)]
            : [refused.length > 0 ? 'Nothing changed.' : 'Nothing changed: those are already your settings.'];
        if (refused.length > 0) lines.push('', 'Not changed:', ...refused.map((line) => `- ${line}`));
        if (blocked || disableBlocked) lines.push('', NEEDS_OWNER_APPROVAL);
        return { text: lines.join('\n'), ...(changed.length === 0 && refused.length > 0 ? { isError: true } : {}) };
      },
    },
  ];
  return tools;
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
