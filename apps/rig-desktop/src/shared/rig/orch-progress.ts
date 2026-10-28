import { defineEvent } from '@shared/lib/ipc/events';

/**
 * What a background orchestrator run is doing, as it does it: one line per
 * lookup ("Reading a Slack thread"), resolved when it ends, and one per thing
 * it settles ("Payout delay: Sam resolved it Tuesday", already handled).
 * Main maps the run's ACP tool calls to these (`ProgressMapper`), with no
 * model calls, and sends them on `rigOrchProgressChannel`; the first run's
 * Read step (renderer/features/first-run/read) and its field show them.
 */

/** A lookup running or ended, or an outcome the run reported (`rig_run_note` outcome). */
export type RunProgressStatus = 'running' | 'done' | 'failed' | 'handled' | 'not_yours' | 'for_you';

export type RunProgress = {
  /** Stable per line: the tool call's id, or `outcome:<n>`. A later line with the same id replaces it. */
  id: string;
  /** Where it reads: slack, linear, github, gmail, calendar, notion…; `rig` for Rig's own state; null for the run's own steps. */
  connector: string | null;
  /** In plain words, for the person: "Reading a Slack thread", "Payout delay: Sam resolved it Tuesday". */
  label: string;
  status: RunProgressStatus;
  /** The thing an outcome is about (a ref the run gave), when it gave one. */
  ref?: string;
  /** An outcome about a card already on the Feed before the run: not new to the person. */
  known?: boolean;
  /** Milliseconds since the run started. */
  t: number;
};

/**
 * Why a run couldn't read, each with its one fix: sign in to Rig again, retry
 * when the relay is back, sign Claude in again (signed out, or on an API key
 * that can't reach the connectors), reconnect a connector in claude.ai, or
 * try a run that took too long again.
 */
export const RUN_PROBLEMS = ['rig_signed_out', 'relay_unreachable', 'agent_signed_out', 'connector_auth', 'timeout'] as const;
export type RunProblem = (typeof RUN_PROBLEMS)[number];

export type OrchProgressEvent = (
  /**
   * `lookups`: every planned pass's budget together; a widened pass adds its own when it starts.
   * `since`: a catch-up reads from here (the person's last read), not `lookbackDays` back.
   */
  | { run: string; kind: 'start'; trigger: string; passes: number; lookups: number; lookbackDays: number; since?: string; t: number }
  | { run: string; kind: 'pass'; pass: number; lookups: number; goal: string | null; lookbackDays: number; t: number }
  | { run: string; kind: 'line'; line: RunProgress }
  /** A card went on the Feed (`rig_feed` put). `fresh: false`: it was on the Feed before the run, so it isn't new. */
  | { run: string; kind: 'card'; ref: string; fresh?: boolean; t: number }
  /** What Claude is thinking between lookups, in a few words of its own ("Most of #eng is already resolved"). */
  | { run: string; kind: 'thought'; text: string; t: number }
  /** Something stands in the way of reading, mid-run (a connector that needs reconnecting); the run goes on. */
  | { run: string; kind: 'problem'; problem: RunProblem; connector?: string; t: number }
  | { run: string; kind: 'end'; ok: boolean; error?: string; problem?: RunProblem; t: number }
) & {
  /** Its place in the run, from 0: a listener that joined late, or got the run's events so far, skips what it has. */
  seq?: number;
};

/** Main → window: a run's progress, as it happens. */
export const rigOrchProgressChannel = defineEvent<OrchProgressEvent>('rig:orch-progress');

/** The kinds of outcome a run reports while it reads (`rig_run_note` outcome). */
export const OUTCOME_KINDS = ['handled', 'not_yours', 'for_you'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** `mcp__claude_ai_Slack__slack_read_channel` → its connector and tool; Rig's own tools are `rig`. */
export function toolOf(name: string): { connector: string; tool: string } | null {
  const rig = /^mcp__rig__(.+)$/.exec(name);
  if (rig) return { connector: rig[1] === 'rig_github' ? 'github' : 'rig', tool: rig[1]! };
  const m = /^mcp__(?:claude_ai_)?([A-Za-z0-9_]+?)__(.+)$/.exec(name);
  if (!m) return null;
  const server = m[1]!.toLowerCase().replace(/_/g, '');
  const connector =
    server.includes('slack') ? 'slack'
    : server.includes('linear') ? 'linear'
    : server.includes('gmail') ? 'gmail'
    : server.includes('calendar') ? 'calendar'
    : server.includes('notion') ? 'notion'
    : server.includes('github') ? 'github'
    : server.includes('granola') ? 'granola'
    : server.includes('drive') ? 'drive'
    : server;
  return { connector, tool: m[2]! };
}

type Input = Record<string, unknown>;
const text = (v: unknown, max = 60): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** A channel by name when the input names one (#eng), never an id (C0123…). */
const channel = (input: Input): string | null => {
  const raw = text(input.channel_name) ?? text(input.channel) ?? text(input.channel_id);
  if (!raw || /^[CDG][A-Z0-9]{6,}$/.test(raw)) return null;
  return raw.startsWith('#') ? raw : `#${raw}`;
};
const quoted = (v: unknown) => {
  const q = text(v, 48);
  return q ? ` for "${q}"` : '';
};

/** Per connector: a tool and its input as one plain line. The fallback reads the tool's own name. */
const LINES: Record<string, (tool: string, input: Input) => string | null> = {
  slack: (tool, input) => {
    if (tool.includes('read_thread')) return `Reading a thread${channel(input) ? ` in ${channel(input)}` : ' in Slack'}`;
    if (tool.includes('read_channel')) return `Checking ${channel(input) ?? 'a Slack channel'}`;
    if (tool.includes('search_channels')) return 'Finding your Slack channels';
    if (tool.includes('search_users') || tool.includes('read_user_profile')) return 'Looking up someone on Slack';
    if (tool.includes('search')) return `Searching Slack${quoted(input.query)}`;
    if (tool.includes('canvas')) return 'Reading a Slack canvas';
    return null;
  },
  linear: (tool, input) => {
    if (tool === 'list_issues') return input.assignee === 'me' ? 'Listing issues you own' : 'Listing issues';
    if (tool === 'get_issue') return text(input.id, 20) ? `Analyzing Linear ${text(input.id, 20)}` : 'Opening a Linear issue';
    if (tool === 'list_comments') return `Reading the comments on ${text(input.issueId, 20) ?? 'an issue'}`;
    if (tool.includes('project')) return 'Looking at a Linear project';
    if (tool.includes('cycle')) return 'Looking at the current cycle';
    if (tool.includes('user') || tool.includes('team')) return 'Looking up your team on Linear';
    return null;
  },
  github: (tool, input) => {
    const cmd = text(input.command, 200) ?? '';
    const pr = /\bpr (view|diff|checks) (\d+)/.exec(cmd);
    if (pr) return pr[1] === 'view' ? `Reading PR #${pr[2]}` : `Checking PR #${pr[2]}`;
    if (/\bsearch prs\b/.test(cmd) || /\bpr list\b/.test(cmd)) return 'Listing pull requests that wait on you';
    if (/\bissue (view|list)\b/.test(cmd)) return 'Reading GitHub issues';
    return tool === 'rig_github' ? 'Reading GitHub' : null;
  },
  gmail: (tool) => (tool.includes('search') || tool.includes('list') ? 'Reading your inbox' : tool.includes('get') || tool.includes('read') ? 'Opening an email' : null),
  calendar: () => 'Looking at your week',
  notion: (tool) => (tool.includes('search') ? 'Searching Notion' : 'Opening a Notion page'),
  rig: (tool, input) => {
    if (tool === 'rig_query') return `Looking at what Rig knows${text(input.kind, 20) ? `: ${String(input.kind)}` : ''}`;
    if (tool === 'rig_get') return 'Opening one of your open loops';
    if (tool === 'rig_situation') return 'Keeping track of an open loop';
    if (tool === 'rig_feed') return input.op === 'retire' ? 'Taking a card off your Feed' : 'Putting a card on your Feed';
    if (tool === 'rig_check') return 'Checking an assumption';
    if (tool === 'rig_remember') return 'Remembering a fact';
    return null;
  },
};

/** The plain line for a tool call, or null for one the person needn't see (the run note, unknown tools). */
export function lineFor(name: string, input: Input): { connector: string; label: string } | null {
  const tool = toolOf(name);
  if (!tool) return null;
  if (tool.tool === 'rig_run_note') return null;
  const label = LINES[tool.connector]?.(tool.tool, input) ?? `Reading ${tool.connector.charAt(0).toUpperCase()}${tool.connector.slice(1)}`;
  return label ? { connector: tool.connector, label } : null;
}

/** An ACP update as the run's raw stream carries it. */
export type AcpToolUpdate = {
  sessionUpdate: string;
  toolCallId?: string;
  name?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  /** A thought chunk's words (`agent_thought_chunk`). */
  content?: { type?: string; text?: unknown } | null;
};

const STATUS: Record<string, RunProgressStatus> = { completed: 'done', failed: 'failed' };

/** A thought's words shown at most this often, so the field reads as thinking, not as a transcript. */
const THOUGHT_EVERY_MS = 1500;
const THOUGHT_MAX = 64;

/**
 * One sentence of Claude's thinking as a short label: its first sentence, without markdown, cut to
 * a few words; null when there's too little to say or it's about the run's own instructions.
 */
export function thoughtLabel(sentence: string): string | null {
  const t = sentence
    .replace(/[*_`>]+/g, '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:;,]+$/, '');
  if (t.length < 12 || /\b(packet|rig_run_note|instructions?|system prompt|tool ?calls?)\b/i.test(t)) return null;
  return t.length > THOUGHT_MAX ? `${t.slice(0, THOUGHT_MAX - 1).replace(/\s+\S*$/, '')}…` : t;
}

type Mapped =
  | { kind: 'line'; line: RunProgress }
  | { kind: 'card'; ref: string; t: number }
  | { kind: 'thought'; text: string; t: number };

/**
 * Turns a run's ACP tool calls into progress, one call at a time: a line when
 * a lookup starts (its words improve as its input streams in), the same line
 * resolved when it ends, an outcome line for each `rig_run_note` outcome, and
 * a card when `rig_feed` puts one. Pure but for its memory of the calls.
 */
export class ProgressMapper {
  private calls = new Map<string, { name: string; input: Input; label: string | null; status: RunProgressStatus | null; reported: boolean }>();
  /** The thought being written, since the last lookup; and when one was last said. */
  private thinking = '';
  private saidAt = -Infinity;

  constructor(private readonly now: () => number) {}

  push(update: AcpToolUpdate): Mapped[] {
    // Its thinking, and the short line it says before each step ("Checking your Slack DMs."): both say what it's doing.
    if (update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'agent_message_chunk') return this.thought(update.content);
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return [];
    // A lookup starts: what it said just before is whole now (it may end without a space), and what it thinks next is a new thought.
    const said = update.sessionUpdate === 'tool_call' ? this.flush() : [];
    const id = update.toolCallId;
    if (!id) return said;
    const was = this.calls.get(id);
    const name = update.name ?? was?.name ?? update.title ?? '';
    const input = update.rawInput && typeof update.rawInput === 'object' ? (update.rawInput as Input) : (was?.input ?? {});
    const call = was ?? { name, input, label: null, status: null, reported: false };
    call.name = name;
    call.input = input;
    this.calls.set(id, call);
    const out: Mapped[] = [...said];
    const t = this.now();
    const ended = update.status ? STATUS[update.status] : undefined;

    const tool = toolOf(name);
    // An outcome the run reports while it reads: its own line, once its input is whole.
    if (tool?.tool === 'rig_run_note') {
      const o = input.outcome && typeof input.outcome === 'object' ? (input.outcome as Input) : null;
      const kind = o && (OUTCOME_KINDS as readonly string[]).includes(String(o.kind)) ? (String(o.kind) as OutcomeKind) : null;
      const label = o ? text(o.text, 120) : null;
      // Only once the call is done: before that its input may still be streaming in.
      if (kind && label && !call.reported && ended === 'done') {
        call.reported = true;
        const ref = text(o!.ref, 120);
        out.push({ kind: 'line', line: { id: `outcome:${id}`, connector: connectorOfRef(ref), label, status: kind, ...(ref ? { ref } : {}), t } });
      }
      return out;
    }
    // A card that went up: on its situation, or (put with open) on the one it opened in the same call.
    if (tool?.tool === 'rig_feed' && ended === 'done' && input.op === 'put') {
      out.push({ kind: 'card', ref: typeof input.ref === 'string' && input.ref ? input.ref : `new:${id}`, t });
    }
    const line = lineFor(name, input);
    if (!line) return out;
    const status = ended ?? call.status ?? 'running';
    if (line.label !== call.label || status !== call.status) {
      call.label = line.label;
      call.status = status;
      out.push({ kind: 'line', line: { id, connector: line.connector, label: line.label, status, t } });
    }
    return out;
  }

  /** A chunk of Claude's thinking: each sentence it finishes may be said, a few seconds apart. */
  private thought(content: AcpToolUpdate['content']): Mapped[] {
    const chunk = content && typeof content === 'object' && 'text' in content && typeof content.text === 'string' ? content.text : '';
    if (!chunk) return [];
    this.thinking += chunk;
    const end = /[.!?\n]\s/.exec(this.thinking);
    if (!end) return [];
    const sentence = this.thinking.slice(0, end.index + 1);
    this.thinking = this.thinking.slice(end.index + end[0].length);
    return this.say(sentence);
  }

  /** What's left of what it was saying, said now: a lookup is starting. */
  private flush(): Mapped[] {
    const rest = this.thinking;
    this.thinking = '';
    return rest.trim() ? this.say(rest) : [];
  }

  private say(sentence: string): Mapped[] {
    const t = this.now();
    const text = thoughtLabel(sentence);
    if (!text || t - this.saidAt < THOUGHT_EVERY_MS) return [];
    this.saidAt = t;
    return [{ kind: 'thought', text, t }];
  }
}

/** The connector a ref points into, for an outcome's logo: msg:slack:… → slack, item:ULY-1 → linear. */
export function connectorOfRef(ref: string | null): string | null {
  if (!ref) return null;
  const m = /^(?:msg|thread|ev):([a-z]+)/.exec(ref) ?? /^([a-z]+):/.exec(ref);
  if (m && ['slack', 'linear', 'github', 'gmail', 'calendar', 'notion'].includes(m[1]!)) return m[1]!;
  if (/^item:[A-Z][A-Z0-9]*-\d+/.test(ref)) return 'linear';
  if (/#\d+$/.test(ref)) return 'github';
  return null;
}

/** Claude's own words when it is signed out, or on a key that can't reach the person's connectors. */
const AGENT_SIGNED_OUT = /not logged in|please run \/login|invalid api key|authentication_error|oauth token (?:has )?expired|no such tool available: mcp__claude_ai_/i;
/** A connector's own words when its sign-in lapsed. */
const CONNECTOR_AUTH = /needs? (?:re-?)?auth|re-?authenticat|unauthori[sz]ed|invalid_auth|not_authed|token_(?:revoked|expired)|\b401\b|reconnect/i;

/** Why a run stopped, from what Claude or the runtime said, when it says. */
export function agentProblemOf(text: string): RunProblem | undefined {
  return AGENT_SIGNED_OUT.test(text) ? 'agent_signed_out' : undefined;
}

/** Whether a failed lookup in one of the person's connectors failed for want of a sign-in. */
export function connectorNeedsAuth(text: string): boolean {
  return CONNECTOR_AUTH.test(text);
}
