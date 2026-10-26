import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import type { RigAccountError } from '@shared/rig/account';
import type {
  RigDecision,
  RigFeed,
  RigFeedCard,
  RigFeedItem,
  RigFeedSignal,
  RigSituation,
  RigSituationEvent,
} from '@shared/rig/feed';
import { isError, resolveContext } from '../account';
import { fetchRelay } from '../relay-request';

/**
 * The orchestrator's Feed routes on the relay (tap relay
 * routes/orchestrator.ts): read the Feed and a situation, answer a card, and
 * the corrections any agent may make (hide, merge, move an event). All are
 * account-scoped (`/v1/me/…`). A relay without the routes answers 404, which
 * reads as `unsupported`, which Home says plainly (`feed-notice.tsx`).
 */

export type FeedRelayError =
  | RigAccountError
  | { kind: 'unsupported'; message: string }
  | { kind: 'busy'; message: string };

const REQUEST_TIMEOUT_MS = 15_000;
const ACT_TIMEOUT_MS = 90_000;

async function call(
  method: 'GET' | 'POST',
  path: string,
  action: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Result<unknown, FeedRelayError>> {
  const ctx = await resolveContext();
  if (isError(ctx)) return err(ctx);
  let response: Response;
  try {
    response = await fetchRelay(new URL(path, ctx.url), {
      method,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    log.warn('feed: relay request failed', { action, error: String(error) });
    return err({
      kind: 'relay',
      message: `Could not ${action}. Rig can't reach the server right now.`,
    });
  }
  if (response.status === 404 && path === '/v1/me/feed')
    return err({ kind: 'unsupported', message: "This server doesn't have the Feed yet." });
  if (response.status === 409)
    return err({
      kind: 'busy',
      message: `Could not ${action}: Rig is updating your Feed. Try again in a moment.`,
    });
  if (!response.ok) {
    if (response.status === 401)
      return err({ kind: 'invalidToken', message: 'Your Rig session expired. Sign in again.' });
    if (response.status === 404)
      return err({ kind: 'relay', message: `Could not ${action}: it doesn't exist (any more).` });
    return err({ kind: 'relay', message: `Could not ${action} (${response.status}).` });
  }
  return ok(await response.json().catch(() => ({})));
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function shapeDecision(v: unknown): RigDecision | null {
  const d = rec(v);
  if (!str(d.do)) return null;
  return {
    do: d.do as RigDecision['do'],
    conf: typeof d.conf === 'number' ? d.conf : 0,
    who: str(d.who),
    look: str(d.look),
    trigger: str(d.trigger),
  };
}

const VERBS = new Set(['reply', 'start', 'space', 'open']);

function shapeCard(v: unknown): RigFeedCard | null {
  const c = rec(v);
  if (!str(c.title)) return null;
  const choices = (Array.isArray(c.choices) ? c.choices : [])
    .map(rec)
    .filter((x) => VERBS.has(str(x.verb)) && str(x.lead))
    .map((x) => ({ verb: str(x.verb) as RigFeedCard['choices'][number]['verb'], label: str(x.label), lead: str(x.lead), tail: str(x.tail) }));
  return { title: str(c.title), why: str(c.why), action: str(c.action), choices, people: strs(c.people), refsOk: c.refsOk === true };
}

function shapeItem(v: unknown): RigFeedItem | null {
  const x = rec(v);
  if (!str(x.situationId)) return null;
  return {
    situationId: str(x.situationId),
    sources: strs(x.sources),
    bindingId: str(x.bindingId) || null,
    title: str(x.title),
    description: str(x.description),
    participants: strs(x.participants),
    decision: shapeDecision(x.decision),
    card: shapeCard(x.card),
    updatedAt: str(x.updatedAt),
  };
}

const items = (v: unknown) =>
  Array.isArray(v) ? v.map(shapeItem).filter((x): x is RigFeedItem => x !== null) : [];

export async function getFeed(): Promise<Result<RigFeed, FeedRelayError>> {
  const res = await call('GET', '/v1/me/feed', 'load your Feed');
  if (!res.success) return res;
  const r = rec(res.data);
  return ok({
    me: str(r.me) || null,
    visible: items(r.visible),
    queued: items(r.queued),
    following: items(r.following),
    snoozed: items(r.snoozed),
    digest: (Array.isArray(r.digest) ? r.digest : []).map((d) => ({
      title: str(rec(d).title),
      source: str(rec(d).source) || undefined,
      at: str(rec(d).at) || undefined,
    })),
  });
}

export async function getSituation(id: string): Promise<Result<RigSituation, FeedRelayError>> {
  const res = await call(
    'GET',
    `/v1/me/situations/${encodeURIComponent(id)}`,
    'load that situation'
  );
  if (!res.success) return res;
  const r = rec(res.data);
  const s = rec(r.situation);
  const events: RigSituationEvent[] = (Array.isArray(r.events) ? r.events : []).map((e) => {
    const x = rec(e);
    return {
      id: str(x.id),
      ref: str(x.ref),
      source: str(x.source),
      from: str(x.from_person) || null,
      title: str(x.title),
      summary: str(x.summary),
      excerpt: str(x.excerpt),
      url: str(rec(x.meta).url) || null,
      at: str(x.occurred_at),
      attachedBy: str(x.attached_by),
    };
  });
  return ok({
    id: str(s.id),
    title: str(s.title),
    description: str(s.description),
    status: (str(s.status) || 'open') as RigSituation['status'],
    participants: strs(s.participants),
    decision: shapeDecision(s.decision),
    events,
    explain: str(r.explain) || null,
  });
}

export async function answerCard(
  situationId: string,
  signal: RigFeedSignal,
  detail: { choice?: string; until?: string } = {}
): Promise<Result<null, FeedRelayError>> {
  const res = await call(
    'POST',
    `/v1/me/feed/${encodeURIComponent(situationId)}/${signal}`,
    signal === 'act' ? 'mark it done' : signal === 'ignore' ? 'ignore it' : 'snooze it',
    detail
  );
  return res.success ? ok(null) : res;
}

export async function hideCard(
  situationId: string,
  reason: string,
  actor: string
): Promise<Result<null, FeedRelayError>> {
  const res = await call(
    'POST',
    `/v1/me/feed/${encodeURIComponent(situationId)}/hide`,
    'hide that card',
    { reason, actor }
  );
  return res.success ? ok(null) : res;
}

export async function mergeSituations(
  keep: string,
  absorb: string[],
  reason: string,
  actor: string
): Promise<Result<{ decision: RigDecision | null }, FeedRelayError>> {
  const res = await call('POST', '/v1/me/situations/merge', 'merge those situations', {
    keep,
    absorb,
    reason,
    actor,
  });
  return res.success ? ok({ decision: shapeDecision(rec(res.data).decision) }) : res;
}

export async function moveEvent(
  eventId: string,
  to: string,
  reason: string,
  actor: string
): Promise<Result<{ situationId: string }, FeedRelayError>> {
  const res = await call(
    'POST',
    `/v1/me/orch/events/${encodeURIComponent(eventId)}/move`,
    'move that event',
    { to, reason, actor }
  );
  return res.success ? ok({ situationId: str(rec(res.data).situationId) }) : res;
}

// ────────── the four primitives' relay half (rig docs/orchestrator-design.md §10.3) ──────────

export type OrchRow = { ref: string; title: string } & Record<string, unknown>;
export type OrchQuery = { kind: string; rows: OrchRow[] } | { kind: string; unavailable: true; message: string };

export async function orchQuery(
  kind: string,
  opts: { since?: string; limit?: number; filter?: Record<string, unknown> } = {}
): Promise<Result<OrchQuery, FeedRelayError>> {
  const params = new URLSearchParams({ kind });
  if (opts.since) params.set('since', opts.since);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.filter && Object.keys(opts.filter).length) params.set('filter', JSON.stringify(opts.filter));
  const res = await call('GET', `/v1/me/orch/query?${params}`, `list ${kind}`);
  return res.success ? ok(res.data as OrchQuery) : res;
}

export async function orchGet(ref: string): Promise<Result<Record<string, unknown>, FeedRelayError>> {
  const res = await call('GET', `/v1/me/orch/get?ref=${encodeURIComponent(ref)}`, 'read that');
  return res.success ? ok(rec(res.data)) : res;
}

export type OrchActResult = {
  ref: string;
  ok: boolean;
  message: string;
  changeId?: string;
  card?: { action: string; title: string; detail: string; refs: string[] };
};

export async function orchAct(
  refs: string[],
  action: string,
  args: Record<string, unknown>,
  actor: string
): Promise<Result<OrchActResult[], FeedRelayError>> {
  // The relay may wait up to a minute for a worker pass to let go of the person's lease.
  const res = await call('POST', '/v1/me/orch/act', action, { refs, action, args, actor }, ACT_TIMEOUT_MS);
  if (!res.success) return res;
  const results = rec(res.data).results;
  return ok(Array.isArray(results) ? (results as OrchActResult[]) : []);
}

export async function orchEvents(events: unknown[]): Promise<Result<{ added: number }, FeedRelayError>> {
  const res = await call('POST', '/v1/me/orch/events', 'send what came in', { events });
  return res.success ? ok({ added: Number(rec(res.data).added) || 0 }) : res;
}

export async function linkSession(runId: string, situationId: string, bindingId: string): Promise<Result<null, FeedRelayError>> {
  const res = await call('POST', '/v1/me/orch/sessions', 'link the session to its card', { runId, situationId, bindingId });
  return res.success ? ok(null) : res;
}

// ────────── the background orchestrator (orch/agent.ts) ──────────

/** Where a run should look: the last run's cursors, what is due, Rig's own new events, the person and their rules. */
export type OrchAgentState = {
  me: string | null;
  profile: string;
  rules: { ref: string; text: string }[];
  lastRun: { id: string; at: string } | null;
  cursors: Record<string, string>;
  due: { ref: string; title: string; at: string; why: string }[];
  events: { ref: string; source: string; kind: string; line: string; for: string | null; at: string }[];
  counts: { open: number; visible: number; queued: number; following: number; untopiced: number };
  /** Visible situations with no card written yet. */
  bare: { ref: string; title: string }[];
};

export async function orchAgentState(): Promise<Result<OrchAgentState, FeedRelayError>> {
  const res = await call('GET', '/v1/me/orch/agent', "read where Rig's run should look");
  if (!res.success) return res;
  const r = rec(res.data);
  return ok({
    me: str(r.me) || null,
    profile: str(r.profile),
    rules: (Array.isArray(r.rules) ? r.rules : []).map((x) => ({ ref: str(rec(x).ref), text: str(rec(x).text) })),
    lastRun: r.lastRun ? { id: str(rec(r.lastRun).id), at: str(rec(r.lastRun).at) } : null,
    cursors: Object.fromEntries(Object.entries(rec(r.cursors)).map(([k, v]) => [k, str(v)])),
    due: (Array.isArray(r.due) ? r.due : []).map((x) => ({ ref: str(rec(x).ref), title: str(rec(x).title), at: str(rec(x).at), why: str(rec(x).why) })),
    events: (Array.isArray(r.events) ? r.events : []).map((x) => {
      const e = rec(x);
      return { ref: str(e.ref), source: str(e.source), kind: str(e.kind), line: str(e.line), for: str(e.for) || null, at: str(e.at) };
    }),
    counts: { open: Number(rec(r.counts).open) || 0, visible: Number(rec(r.counts).visible) || 0, queued: Number(rec(r.counts).queued) || 0, following: Number(rec(r.counts).following) || 0, untopiced: Number(rec(r.counts).untopiced) || 0 },
    bare: (Array.isArray(r.bare) ? r.bare : []).map((x) => ({ ref: str(rec(x).ref), title: str(rec(x).title) })),
  });
}

export async function orchCheck(check: string, subject: string): Promise<Result<{ question: string; answer: number }, FeedRelayError>> {
  const res = await call('POST', '/v1/me/orch/check', 'run the check', { check, subject });
  if (!res.success) return res;
  return ok({ question: str(rec(res.data).question), answer: Number(rec(res.data).answer) || 0 });
}

export async function orchFact(fact: { about: string; fact: string; refs: string[]; until?: string; source?: string; actor: string }): Promise<Result<{ id: string }, FeedRelayError>> {
  const res = await call('POST', '/v1/me/orch/facts', 'remember that', fact);
  return res.success ? ok({ id: str(rec(res.data).id) }) : res;
}

export async function orchRun(id: string, trigger: string, note?: Record<string, unknown>): Promise<Result<null, FeedRelayError>> {
  const res = await call('POST', '/v1/me/orch/runs', 'record the run', { id, trigger, ...(note ? { note } : {}) });
  return res.success ? ok(null) : res;
}
