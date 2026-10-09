import { isAbsolute, relative, resolve, sep } from 'node:path';
import { RIG_TOOLS_SERVER, RUN_CONNECTORS_EVENT } from '@shared/spaces/connectors';
import { PRIVATE_PROGRESS_EVENT, RUN_PRIVACY_EVENT, RUN_RETRIED_EVENT, type RoomSees } from '@shared/spaces/room-sees';

/**
 * "Room sees" (see `shared/spaces/room-sees.ts`), enforced on the member's
 * own computer: what one run's events become before `SessionEventPublisher`
 * uploads them. Ported from the trace-privacy spike's `TierFilter`
 * (`rig/docs/trace-privacy-spike.md`), with the rule the founder approved:
 *
 * - **Everything**: every event as today.
 * - **Steps**: an allowlist, so an unknown or future event kind is dropped.
 *   Each step goes up as a label built only from fields that can't carry
 *   free text (the tool's kind, the tool or connector's name, a path inside
 *   the space), never the adapter's title, input or output. What a
 *   connector returned (any MCP tool, the space's or the agent's own) and
 *   any file outside the space's folder is marked `private: true`: others
 *   see the label with a lock. Edits to the space's own files keep their
 *   diffs (sync shows those files to every member anyway). The plan is
 *   shared; thinking, narration and raw tool input/output are not.
 * - **Answer**: only how many steps it took (`private_progress`), how it
 *   ended, and the final answer.
 *
 * At Steps and Answer the answer is held back and sent whole when the turn
 * ends: while the agent streams, a message can't be told apart from
 * narration between steps, and the relay has no delete for narration
 * already sent.
 */

export type FilteredEvent = {
  kind: string;
  payload: Record<string, unknown>;
  /** Send in a batch of its own, so the relay never merges it with a neighbour past its size cap. */
  ownBatch?: boolean;
};

/** Answer pieces stay under the relay's 16 KB per-event cap even at 4 bytes a character. */
const ANSWER_PIECE_CHARS = 3500;

/** Claude's built-in tools that say what they did by name alone. */
const KNOWN_TOOLS: Record<string, string> = {
  ToolSearch: 'Looked up tools',
  TodoWrite: 'Updated the plan',
  Task: 'Started a subagent',
  Agent: 'Started a subagent',
  WebSearch: 'Searched the web',
  WebFetch: 'Opened a web page',
  Skill: 'Used a skill',
};

const FILE_VERB: Record<string, string> = { read: 'Read', edit: 'Edited', delete: 'Deleted', move: 'Moved' };
/** Kinds whose paths decide whether the step touched something outside the space. */
const FILE_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search']);

/** An MCP tool name as agents report it (`mcp__server__tool`, Codex `mcp.server.tool`), identifier characters only. */
const MCP_NAME = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$|^mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;

/** A path relative to the space's folder when it's inside it, else null. Relative paths are the agent's cwd, the space. */
export function insideSpace(path: string, root: string): string | null {
  if (!root || !path || path.startsWith('~')) return null;
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(resolve(root), abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

type ToolState = {
  kind: string;
  /** The tool's own name (never its title): `Read`, `Bash`, `mcp__granola__search`… */
  name: string;
  /** Every path the step reported, as reported. */
  paths: string[];
  status?: string;
};

/** The tool's name from fields that carry a name, not prose. */
function toolNameOf(payload: Record<string, unknown>): string | null {
  const claude = record(record(payload._meta)?.claudeCode)?.toolName;
  if (typeof claude === 'string' && claude) return claude;
  if (typeof payload.name === 'string' && payload.name) return payload.name;
  // Codex wraps an MCP call's input as `{ server, tool, arguments }`.
  const input = record(payload.rawInput);
  if (typeof input?.server === 'string' && typeof input.tool === 'string') {
    const name = `mcp__${input.server}__${input.tool}`;
    if (MCP_NAME.test(name)) return name;
  }
  if (typeof payload.title === 'string' && MCP_NAME.test(payload.title)) return payload.title;
  return null;
}

function pathsOf(payload: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (Array.isArray(payload.locations)) {
    for (const loc of payload.locations) {
      const path = record(loc)?.path;
      if (typeof path === 'string' && path) paths.push(path);
    }
  }
  const input = record(payload.rawInput);
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input?.[key];
    if (typeof value === 'string' && value) paths.push(value);
  }
  if (Array.isArray(payload.content)) {
    for (const block of payload.content) {
      const b = record(block);
      if (b?.type === 'diff' && typeof b.path === 'string' && b.path) paths.push(b.path);
    }
  }
  return paths;
}

function isMcp(name: string): boolean {
  return MCP_NAME.test(name);
}

function isRigTool(name: string): boolean {
  return name.startsWith(`mcp__${RIG_TOOLS_SERVER}__`) || name.startsWith(`mcp.${RIG_TOOLS_SERVER}.`);
}

export class RoomSeesFilter {
  private readonly tools = new Map<string, ToolState>();
  private answer: { messageId: unknown; text: string } = { messageId: null, text: '' };

  constructor(
    readonly level: RoomSees,
    /** The space's folder on this computer: the agent's cwd. */
    readonly spaceRoot: string
  ) {}

  /** How many distinct steps (tool calls) the run has taken so far. */
  get steps(): number {
    return this.tools.size;
  }

  /** One event in, the events the relay may receive out (none, one, or the held-back answer). */
  filter(kind: string, payload: Record<string, unknown>): FilteredEvent[] {
    if (this.level === 'everything') return [{ kind, payload }];
    switch (kind) {
      case RUN_PRIVACY_EVENT:
      case 'run_model':
      case 'permission_decided':
        return [{ kind, payload }];
      case 'tool_call':
      case 'tool_call_update':
        return this.toolEvent(kind, payload);
      case 'permission_requested':
        return [this.permissionRequested(payload)];
      case 'agent_message_chunk':
        this.collectAnswer(payload);
        return [];
      case RUN_RETRIED_EVENT:
        // What the failed try printed is no answer.
        this.answer = { messageId: null, text: '' };
        return [{ kind, payload }];
      case 'plan':
        return this.level === 'steps' ? [this.plan(payload)] : [];
      case 'usage_update':
        return this.level === 'steps' && typeof payload.used === 'number' && typeof payload.size === 'number'
          ? [{ kind, payload: { sessionUpdate: kind, used: payload.used, size: payload.size } }]
          : [];
      case RUN_CONNECTORS_EVENT:
        return this.level === 'steps' ? [{ kind, payload }] : [];
      case 'turn_ended':
        return [...this.flush(), { kind, payload: this.turnEnded(payload) }];
      default:
        // Thinking, session titles, replayed prompts, mode changes, and
        // anything an adapter adds later: not uploaded.
        return [];
    }
  }

  private toolState(payload: Record<string, unknown>): { tool: ToolState; isNew: boolean } | null {
    const id = typeof payload.toolCallId === 'string' ? payload.toolCallId : null;
    if (!id) return null;
    let tool = this.tools.get(id);
    const isNew = !tool;
    if (!tool) {
      tool = { kind: 'other', name: '', paths: [] };
      this.tools.set(id, tool);
    }
    if (typeof payload.kind === 'string' && payload.kind) tool.kind = payload.kind;
    const name = toolNameOf(payload);
    if (name) tool.name = name;
    for (const path of pathsOf(payload)) if (!tool.paths.includes(path)) tool.paths.push(path);
    if (typeof payload.status === 'string') tool.status = payload.status;
    return { tool, isNew };
  }

  /** Whether other members only see this step's label with a lock: a connector's result, or a file outside the space. */
  private isPrivate(tool: ToolState): boolean {
    if (isMcp(tool.name)) return !isRigTool(tool.name);
    return FILE_KINDS.has(tool.kind) && tool.paths.some((p) => insideSpace(p, this.spaceRoot) === null);
  }

  /** The step's label, from its kind, its tool's name and a path inside the space, never its title. */
  label(tool: ToolState): string {
    // The renderer names these ("Granola · search meetings", "Rig · invite").
    if (isMcp(tool.name)) return tool.name;
    const known = KNOWN_TOOLS[tool.name];
    if (known) return known;
    const verb = FILE_VERB[tool.kind];
    if (verb) {
      const rel = tool.paths.length > 0 ? insideSpace(tool.paths[0]!, this.spaceRoot) : null;
      return rel && rel !== '.' ? `${verb} ${rel}` : `${verb} a file`;
    }
    if (tool.kind === 'search') return 'Searched files';
    if (tool.kind === 'execute') return 'Ran a command';
    if (tool.kind === 'fetch') return 'Opened a web page';
    if (tool.kind === 'think') return 'Thought';
    return 'Used a tool';
  }

  private toolEvent(kind: string, payload: Record<string, unknown>): FilteredEvent[] {
    const state = this.toolState(payload);
    if (!state) return [];
    const { tool, isNew } = state;
    if (this.level === 'answer') {
      return isNew ? [{ kind: PRIVATE_PROGRESS_EVENT, payload: { steps: this.steps } }] : [];
    }
    const isPrivate = this.isPrivate(tool);
    const inSpace = tool.paths.flatMap((p) => {
      const rel = insideSpace(p, this.spaceRoot);
      return rel && rel !== '.' ? [rel] : [];
    });
    const diffs = isPrivate ? [] : this.inSpaceDiffs(payload);
    return [
      {
        kind,
        payload: {
          sessionUpdate: kind,
          toolCallId: payload.toolCallId,
          kind: tool.kind,
          ...(tool.status ? { status: tool.status } : {}),
          title: this.label(tool),
          ...(isPrivate ? { private: true } : {}),
          ...(!isPrivate && inSpace.length > 0 ? { locations: [...new Set(inSpace)].map((path) => ({ path })) } : {}),
          ...(diffs.length > 0 ? { content: diffs } : {}),
        },
      },
    ];
  }

  /** An edit's diffs, for files inside the space only, with space-relative paths. */
  private inSpaceDiffs(payload: Record<string, unknown>): Array<Record<string, unknown>> {
    if (!Array.isArray(payload.content)) return [];
    return payload.content.flatMap((block) => {
      const b = record(block);
      if (b?.type !== 'diff' || typeof b.path !== 'string') return [];
      const rel = insideSpace(b.path, this.spaceRoot);
      if (!rel || rel === '.') return [];
      return [
        {
          type: 'diff',
          path: rel,
          ...(typeof b.oldText === 'string' ? { oldText: b.oldText } : { oldText: null }),
          newText: typeof b.newText === 'string' ? b.newText : '',
        },
      ];
    });
  }

  private permissionRequested(payload: Record<string, unknown>): FilteredEvent {
    const toolCallId = record(payload.toolCall)?.toolCallId;
    const tool = typeof toolCallId === 'string' ? this.tools.get(toolCallId) : undefined;
    return {
      kind: 'permission_requested',
      payload: {
        requestId: payload.requestId,
        ...(typeof payload.pubTs === 'number' ? { pubTs: payload.pubTs } : {}),
        // The owner answers from their own, unfiltered copy (the local overlay).
        private: true,
        toolCall: { toolCallId, title: this.level === 'steps' && tool ? this.label(tool) : null },
        // Option names embed the command ("don't ask again for `rig history *`").
        options: [],
      },
    };
  }

  private plan(payload: Record<string, unknown>): FilteredEvent {
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    return {
      kind: 'plan',
      payload: {
        sessionUpdate: 'plan',
        entries: entries.flatMap((raw) => {
          const entry = record(raw);
          if (!entry || typeof entry.content !== 'string') return [];
          return [{ content: entry.content, status: typeof entry.status === 'string' ? entry.status : 'pending' }];
        }),
      },
    };
  }

  private turnEnded(payload: Record<string, unknown>): Record<string, unknown> {
    // A reaction is on the message for everyone to see already.
    const reacted = Array.isArray(payload.reacted) ? payload.reacted.filter((e) => typeof e === 'string') : [];
    return {
      ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      ...(reacted.length > 0 ? { reacted } : {}),
    };
  }

  /** The turn's latest agent message so far: a new message id starts it over, so narration between steps is left behind. */
  private collectAnswer(payload: Record<string, unknown>): void {
    const pieces = Array.isArray(payload.chunks) ? payload.chunks : [payload];
    for (const raw of pieces) {
      const piece = record(raw);
      const content = record(piece?.content);
      if (!piece || content?.type !== 'text' || typeof content.text !== 'string') continue;
      if (piece.messageId !== this.answer.messageId) this.answer = { messageId: piece.messageId, text: '' };
      this.answer.text += content.text;
    }
  }

  /** The held-back answer, in pieces the relay stores whole, then (at Answer) the final step count. */
  private flush(): FilteredEvent[] {
    const out: FilteredEvent[] = [];
    const { messageId, text } = this.answer;
    for (let i = 0; i < text.length; i += ANSWER_PIECE_CHARS) {
      out.push({
        kind: 'agent_message_chunk',
        payload: {
          sessionUpdate: 'agent_message_chunk',
          ...(messageId !== null && messageId !== undefined ? { messageId } : {}),
          content: { type: 'text', text: text.slice(i, i + ANSWER_PIECE_CHARS) },
        },
        ownBatch: true,
      });
    }
    this.answer = { messageId: null, text: '' };
    if (this.level === 'answer') out.push({ kind: PRIVATE_PROGRESS_EVENT, payload: { steps: this.steps, final: true } });
    return out;
  }
}
