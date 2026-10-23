import type { AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok, type Result } from '@emdash/shared';
import { finalAnswerFromEvents, type RawSessionEvent, type SpacesAcpSessions } from '../spaces/dispatch';

/**
 * Sources: what Rig watches for the person, through their own Claude's
 * connectors (rig docs/orchestrator-design.md §13, spikes S1–S2). A run is a
 * short headless Claude session on this Mac: it may only call the source
 * connector's read tools (anything else is refused), lists what changed since
 * the cursor as JSON, and Rig turns each line into an orchestrator event. The
 * session lists; Rig writes. Item bodies stay on the Mac apart from a short
 * excerpt.
 */

export type SourceStatus = 'ok' | 'failed' | 'needs_auth' | 'running';

export type Source = {
  /** `src_linear`, `src_slack`. */
  ref: string;
  /** The claude.ai connector's name as Claude lists it: "Linear", "Slack". */
  connector: string;
  /** What to watch, in words: "issues in the Ulys team". */
  what: string;
  everyMin: number;
  paused: boolean;
  /** ISO time of the newest item seen; the next run asks for what changed after it. */
  cursor: string | null;
  lastRun: string | null;
  lastStatus: SourceStatus | null;
  lastCount: number;
  lastError?: string;
};

export type SourcesStore = { read(): Promise<Source[]>; write(sources: Source[]): Promise<void> };

/** One event for the relay's import route (`POST /v1/me/orch/events`). */
export type ImportEvent = {
  sourceKey: string;
  source: string;
  kind: string;
  ref: string;
  threadKey?: string;
  from?: string | null;
  title: string;
  summary?: string;
  excerpt?: string;
  at: string;
  meta?: Record<string, unknown>;
  /** The situation this event is about, when Rig went looking for it (a check, a session's result). */
  sessionFor?: string;
};

export type SourceRunnerDeps = {
  acp: Pick<SpacesAcpSessions, 'startSession' | 'queuePrompt' | 'subscribeRaw' | 'subscribePendingPermissions' | 'resolvePermission' | 'stopSession'>;
  cwd: () => Promise<string>;
  newConversationId: () => string;
  postEvents: (events: ImportEvent[]) => Promise<Result<{ added: number }, { message: string }>>;
  now: () => number;
  timeoutMs?: number;
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
};

const slug = (connector: string) => connector.replace(/[^A-Za-z0-9]+/g, '_');
const READ_VERB = /(^|_)(list|get|search|read|fetch|query|find)/i;

/** Allow the source connector's read tools once; refuse everything else. */
export function sourcePermission(connector: string, request: AcpPermissionRequest): string | null {
  const title = request.toolCall.title ?? '';
  const prefix = `mcp__claude_ai_${slug(connector)}__`;
  const allowed = title.startsWith(prefix) && READ_VERB.test(title.slice(prefix.length));
  const want = allowed ? 'allow_once' : 'reject_once';
  return request.options.find((o) => o.kind === want)?.optionId ?? null;
}

export const SOURCE_RULES =
  "You list what changed in one of the person's tools for Rig, read-only. Use only that tool's list, search and get calls. Never write, comment, send or change anything. Reply with JSON only, no prose: a JSON array, [] when nothing changed.";

/** What a run asks for, per connector: the fields Rig maps into events. */
export function sourcePrompt(source: Source, since: string): string {
  if (/linear/i.test(source.connector))
    return [
      `Using the Linear connector, list ${source.what} updated after ${since}, most recent first, at most 50.`,
      'Reply with only a JSON array of objects with these keys: id (like ULY-429), title, url, state, priority, assignee (name or null), creator (name or null), updatedAt (ISO), summary (one line, at most 120 characters, your reading of the issue), excerpt (at most 280 characters of the description).',
    ].join(' ');
  if (/slack/i.test(source.connector))
    return [
      `Using the Slack connector, list ${source.what} posted after ${since}, oldest first, at most 50.`,
      'Reply with only a JSON array of objects with these keys: ts, channel (name), channelId, threadTs (or null), from (display name), text (at most 280 characters), permalink (or null).',
    ].join(' ');
  return `Using the ${source.connector} connector, list ${source.what} changed after ${since}, at most 50. Reply with only a JSON array of objects with keys: id, title, from, updatedAt (ISO), text (at most 280 characters), url.`;
}

/** The first JSON array in an answer, or null. */
export function parseJsonArray(text: string): Record<string, unknown>[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : null;
  } catch {
    return null;
  }
}

const s = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A listed line as an orchestrator event; null when it lacks what Rig needs. */
export function toImportEvent(source: Source, line: Record<string, unknown>): ImportEvent | null {
  if (/linear/i.test(source.connector)) {
    const id = s(line.id, 40);
    const at = s(line.updatedAt, 40);
    if (!id || !at || Number.isNaN(Date.parse(at))) return null;
    return {
      sourceKey: `${id}@${at}`,
      source: 'linear',
      kind: 'ticket updated',
      ref: `item:${id}`,
      from: s(line.assignee, 120) || s(line.creator, 120) || null,
      title: `${id}: ${s(line.title, 200)}`,
      summary: [s(line.state, 40), s(line.priority, 40), `owner ${s(line.assignee, 80) || 'nobody'}`].filter(Boolean).join(' · '),
      excerpt: s(line.summary, 120) || s(line.excerpt, 280),
      at: new Date(at).toISOString(),
      meta: { url: s(line.url, 400), sourceRef: source.ref },
    };
  }
  if (/slack/i.test(source.connector)) {
    const ts = s(line.ts, 40);
    const channel = s(line.channelId, 40) || s(line.channel, 80);
    if (!ts || !channel || !Number.isFinite(Number(ts))) return null;
    const thread = s(line.threadTs, 40) || ts;
    return {
      sourceKey: `${channel}:${ts}`,
      source: 'slack',
      kind: thread !== ts ? 'thread reply' : 'message',
      ref: `msg:slack:${channel}:${ts}`,
      threadKey: `slack:${channel}:${thread}`,
      from: s(line.from, 120) || null,
      title: `#${s(line.channel, 80) || channel}`,
      excerpt: s(line.text, 280),
      at: new Date(Number(ts) * 1000).toISOString(),
      meta: { url: s(line.permalink, 400), sourceRef: source.ref },
    };
  }
  const id = s(line.id, 80);
  const at = s(line.updatedAt, 40);
  if (!id || !at || Number.isNaN(Date.parse(at))) return null;
  return {
    sourceKey: `${id}@${at}`,
    source: slug(source.connector).toLowerCase(),
    kind: 'item',
    ref: `item:${slug(source.connector).toLowerCase()}/${id}`,
    from: s(line.from, 120) || null,
    title: s(line.title, 200) || id,
    excerpt: s(line.text, 280),
    at: new Date(at).toISOString(),
    meta: { url: s(line.url, 400), sourceRef: source.ref },
  };
}

export type RunOutcome = { status: SourceStatus; listed: number; added: number; cursor: string | null; error?: string };

/** A headless session's dependencies: the ACP sessions and a folder to run in. */
export type HeadlessDeps = Pick<SourceRunnerDeps, 'acp' | 'cwd' | 'newConversationId' | 'timeoutMs'>;

/**
 * One short headless Claude session on this Mac: one prompt, its permission
 * requests answered by `permission` (anything it doesn't allow is refused),
 * and the final answer's text. Always stopped afterwards. Never throws.
 */
export async function askHeadless(
  deps: HeadlessDeps,
  input: { rules: string; prompt: string; permission: (request: AcpPermissionRequest) => string | null }
): Promise<Result<string, string>> {
  const conversationId = deps.newConversationId();
  const cwd = await deps.cwd();
  const started = await deps.acp.startSession({ conversationId, providerId: 'claude', cwd, systemPromptAppend: input.rules });
  if (!started.success) return err(started.error);
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  let finish!: (r: Result<string, string>) => void;
  const done = new Promise<Result<string, string>>((resolve) => (finish = resolve));
  let begun = false;
  const offRaw = await deps.acp.subscribeRaw(conversationId, (raw: RawSessionEvent) => {
    if (raw.kind === 'turn_start') begun = true;
    else if (raw.kind === 'acp_update') events.push({ kind: raw.update.sessionUpdate, payload: raw.update });
    else if (raw.kind === 'turn_end' && begun) finish(ok(finalAnswerFromEvents(events)));
  });
  const offPerm = await deps.acp.subscribePendingPermissions(conversationId, (request) => {
    const optionId = input.permission(request);
    if (optionId) void deps.acp.resolvePermission(conversationId, request.requestId, optionId).catch(() => undefined);
  });
  const timer = setTimeout(() => finish(err('The run took too long.')), deps.timeoutMs ?? 4 * 60_000);
  try {
    const queued = await deps.acp.queuePrompt(conversationId, input.prompt, undefined, (reason) => finish(err(reason)));
    if (!queued.success) return err(queued.error);
    return await done;
  } finally {
    clearTimeout(timer);
    offRaw();
    offPerm();
    await deps.acp.stopSession?.(conversationId).catch(() => undefined);
  }
}

/** One run of one source: list, map, send. Never throws. */
export async function runSource(deps: SourceRunnerDeps, source: Source): Promise<RunOutcome> {
  const since = source.cursor ?? new Date(deps.now() - 3 * 86_400_000).toISOString();
  const answer = await askHeadless(deps, {
    rules: SOURCE_RULES,
    prompt: sourcePrompt(source, since),
    permission: (request) => sourcePermission(source.connector, request),
  });
  if (!answer.success) return { status: 'failed', listed: 0, added: 0, cursor: source.cursor, error: answer.error };
  const lines = parseJsonArray(answer.data);
  if (!lines) {
    const needsAuth = /auth|connect|not available|don't have access/i.test(answer.data);
    return { status: needsAuth ? 'needs_auth' : 'failed', listed: 0, added: 0, cursor: source.cursor, error: answer.data.slice(0, 300) };
  }
  const mapped = lines.map((l) => toImportEvent(source, l)).filter((e): e is ImportEvent => e !== null);
  const cursor = mapped.reduce<string | null>((max, e) => (!max || e.at > max ? e.at : max), source.cursor);
  if (!mapped.length) return { status: 'ok', listed: lines.length, added: 0, cursor };
  const sent = await deps.postEvents(mapped);
  if (!sent.success) return { status: 'failed', listed: lines.length, added: 0, cursor: source.cursor, error: sent.error.message };
  return { status: 'ok', listed: lines.length, added: sent.data.added, cursor };
}

/** Sources due for a run now. */
export const dueSources = (sources: Source[], now: number) =>
  sources.filter((x) => !x.paused && x.lastStatus !== 'running' && (!x.lastRun || now - Date.parse(x.lastRun) >= x.everyMin * 60_000));
