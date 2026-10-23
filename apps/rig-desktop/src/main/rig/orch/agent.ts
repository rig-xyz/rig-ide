import type { AcpHttpMcpServerWire, AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok, type Result } from '@emdash/shared';
import type { OrchAgentState } from '../feed/relay';
import { finalAnswerFromEvents, type RawSessionEvent, type SpacesAcpSessions } from '../spaces/dispatch';
import { ORCHESTRATOR_BINDING, rigToolOf, type RigToolScope } from '../spaces/rig-tools';
import { checkPermission } from './checks';
import { orchestratorSkill } from './skill';

/**
 * The background orchestrator (rig "background orchestrator" design doc):
 * one Claude session on this Mac, on the person's own Claude Code, that
 * decides their Feed. Each run gets a short packet (who they are, their
 * rules, pointers to what's new and due) and fetches the rest itself: Rig's
 * state through the rig_* tools, what's new through their connectors, read
 * only. Everything it changes goes through Rig's tools, which check it, log
 * it and make it undoable. The session lives while the app runs; Rig's state
 * is the memory that outlives it.
 */

/** The tools the orchestrator may call without asking; anything else of Rig's is refused. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(['rig_query', 'rig_get', 'rig_situation', 'rig_feed', 'rig_check', 'rig_remember', 'rig_start', 'rig_run_note']);

export const AGENT_BUDGET = { lookups: 20, firstRead: 40, starts: 3 };

/** Rig's own tools from the list above; connectors' read tools and `gh` reads (checks.ts); nothing else. */
export function agentPermission(request: AcpPermissionRequest): string | null {
  const tool = rigToolOf(request.toolCall.title);
  if (!tool) return checkPermission(request);
  const want = AGENT_TOOLS.has(tool) ? 'allow_once' : 'reject_once';
  return request.options.find((o) => o.kind === want)?.optionId ?? null;
}

/** What a run reads when the person hasn't set up sources: their connectors, by the names cursors use. */
const DEFAULT_SOURCES = [
  { name: 'slack', what: 'your DMs and the channels you are in' },
  { name: 'linear', what: 'issues you created, own or are mentioned in' },
];

export type PacketInput = {
  runId: string;
  now: number;
  trigger: string;
  turnId: string;
  state: OrchAgentState;
  /** What each of the person's sources watches: "Slack: your DMs and #eng-general". */
  sources: { connector: string; what: string }[];
};

const iso = (t: number) => new Date(t).toISOString();

/** The run's packet: who, their rules, and where to look. Behaviour lives in the skill; state is fetched on demand. */
export function buildPacket(p: PacketInput): string {
  const { state } = p;
  const firstSince = iso(p.now - 3 * 86_400_000);
  // Each source by the name the run note uses for its cursor.
  const named = p.sources.length ? p.sources.map((s) => ({ name: s.connector.toLowerCase(), what: s.what })) : DEFAULT_SOURCES;
  // A source with no cursor hasn't been read yet: read its last three days, not just since the last run.
  const fresh = named.filter((s) => !state.cursors[s.name]);
  const sourceLines = named.map((s) => (state.cursors[s.name] ? `${s.name}: ${s.what}, since ${state.cursors[s.name]}` : `${s.name}: ${s.what}, never read: read since ${firstSince}`));
  const firstRead = fresh.length > 0;
  const lookups = firstRead ? AGENT_BUDGET.firstRead : AGENT_BUDGET.lookups;
  return [
    `<run id="${p.runId}" now="${iso(p.now)}" trigger="${p.trigger}" budget="${lookups} lookups, ${AGENT_BUDGET.starts} starts"/>`,
    `<rig_turn user_turn_id="${p.turnId}" />`,
    '',
    '## Who you are',
    state.profile || state.me || 'Unknown: ask nothing, and note it in the run note.',
    '',
    '## Your rules',
    ...(state.rules.length ? state.rules.map((r) => `${r.ref} "${r.text}"`) : ['None yet.']),
    '',
    `## What to read (last run: ${state.lastRun ? state.lastRun.at : 'none, this is the first'})`,
    ...sourceLines,
    ...(firstRead
      ? [`First read of ${fresh.map((s) => s.name).join(' and ')}: search the connector itself for the last three days (Rig's own items don't cover it), and put on the Feed what needs ${state.me || 'them'} now.`]
      : []),
    state.events.length ? `Rig events: ${state.events.map((e) => `${e.ref} ${e.source}${e.for ? ` for ${e.for}` : ''}: ${e.line}`).join(' · ')}` : 'Rig events: none',
    state.due.length ? `Due now: ${state.due.map((d) => `${d.ref} "${d.title}"`).join(' · ')}` : 'Due now: nothing',
    `Open: ${state.counts.open} situations, ${state.counts.visible} cards visible, ${state.counts.queued} queued (rig_query to list them)`,
    `Following: ${state.counts.following} situations, ${state.counts.untopiced} open with no topic: look them over (rig_query situations, filter {"feed":"following"})`,
    ...(state.bare.length ? [`Visible with no card written (your owner sees nothing there): ${state.bare.map((b) => `${b.ref} "${b.title}"`).join(' · ')}`] : []),
    '',
    `End the run with rig_run_note (run_id "${p.runId}"), even when nothing changed. In read, name each source exactly as above (${named.map((s) => s.name).join(', ')}).`,
  ].join('\n');
}

export type OrchestratorDeps = {
  acp: Pick<SpacesAcpSessions, 'startSession' | 'queuePrompt' | 'subscribeRaw' | 'subscribePendingPermissions' | 'resolvePermission' | 'stopSession'>;
  rigTools: (scope: RigToolScope) => Promise<AcpHttpMcpServerWire>;
  whoami: () => Promise<Result<{ id: string }, { message: string }>>;
  cwd: () => Promise<string>;
  newConversationId: () => string;
  state: () => Promise<Result<OrchAgentState, { message: string }>>;
  sources: () => Promise<{ connector: string; what: string }[]>;
  recordRun: (id: string, trigger: string, note?: Record<string, unknown>) => Promise<unknown>;
  issueTurn: () => string;
  now: () => number;
  turnTimeoutMs?: number;
  log?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
};

export type RunResult = { runId: string; noted: boolean; ms: number };

export function createOrchestrator(deps: OrchestratorDeps) {
  let live: { conversationId: string; ownerUserId: string; off: () => void } | null = null;
  let running: Promise<Result<RunResult, string>> | null = null;

  async function ensure(name: string): Promise<Result<{ conversationId: string }, string>> {
    const me = await deps.whoami();
    if (!me.success) return err(me.error.message);
    if (live && live.ownerUserId === me.data.id) return ok({ conversationId: live.conversationId });
    await stop();
    const cwd = await deps.cwd();
    const conversationId = deps.newConversationId();
    const rig = await deps.rigTools({ bindingId: ORCHESTRATOR_BINDING, ownerUserId: me.data.id, agent: 'claude', cwd });
    // The person's own default model, as in their other sessions.
    const started = await deps.acp.startSession({ conversationId, providerId: 'claude', cwd, mcpServers: [rig], systemPromptAppend: orchestratorSkill(name) });
    if (!started.success) return err(started.error);
    const off = await deps.acp.subscribePendingPermissions(conversationId, (request) => {
      const optionId = agentPermission(request);
      // What it was refused shows what it couldn't check: log it.
      const refused = request.options.find((o) => o.optionId === optionId)?.kind !== 'allow_once';
      if (refused) deps.log?.info('Rig orchestrator: refused a tool call', { title: String(request.toolCall.title ?? '').slice(0, 300) });
      if (optionId) void deps.acp.resolvePermission(conversationId, request.requestId, optionId).catch(() => undefined);
    });
    live = { conversationId, ownerUserId: me.data.id, off };
    return ok({ conversationId });
  }

  async function once(trigger: string): Promise<Result<RunResult, string>> {
    const startedAt = deps.now();
    const state = await deps.state();
    if (!state.success) return err(state.error.message);
    const session = await ensure(state.data.me || 'the person');
    if (!session.success) return session;
    const { conversationId } = session.data;
    const runId = `run_${new Date(startedAt).toISOString().replace(/\D/g, '').slice(0, 12)}_${Math.random().toString(36).slice(2, 6)}`;
    await deps.recordRun(runId, trigger);
    const packet = buildPacket({ runId, now: startedAt, trigger, turnId: deps.issueTurn(), state: state.data, sources: await deps.sources() });
    let finish!: (r: Result<null, string>) => void;
    const done = new Promise<Result<null, string>>((resolve) => (finish = resolve));
    let begun = false;
    const events: { kind: string; payload: Record<string, unknown> }[] = [];
    const offRaw = await deps.acp.subscribeRaw(conversationId, (raw: RawSessionEvent) => {
      if (raw.kind === 'turn_start') begun = true;
      else if (raw.kind === 'acp_update' && begun) events.push({ kind: raw.update.sessionUpdate, payload: raw.update });
      else if (raw.kind === 'turn_end' && begun) finish(ok(null));
    });
    const timer = setTimeout(() => finish(err('The run took too long.')), deps.turnTimeoutMs ?? 10 * 60_000);
    try {
      const queued = await deps.acp.queuePrompt(conversationId, packet, undefined, (reason) => finish(err(reason)));
      if (!queued.success) return err(queued.error);
      const ended = await done;
      // The relay's latest noted run is this one only if the run ended with rig_run_note.
      const after = await deps.state();
      const noted = after.success && after.data.lastRun?.id === runId;
      const said = finalAnswerFromEvents(events).trim();
      if (!noted) {
        // No note: keep the cursors where they were, so the next run reads from the same place.
        await deps.recordRun(runId, trigger, {
          read: Object.entries(state.data.cursors).map(([source, until]) => ({ source, until })),
          changed: [],
          left: [],
          summary: ended.success ? `The run ended without a note. Claude's last words: ${said.slice(0, 600) || '(none)'}` : `The run failed: ${ended.error}`,
        });
      }
      deps.log?.info('Rig orchestrator: run ended', { runId, trigger, noted, ms: deps.now() - startedAt, ok: ended.success, said: said.slice(0, 600) });
      return ended.success ? ok({ runId, noted, ms: deps.now() - startedAt }) : err(ended.error);
    } finally {
      clearTimeout(timer);
      offRaw();
    }
  }

  /** One run, now; a call while one runs joins it. */
  function run(trigger: string): Promise<Result<RunResult, string>> {
    running ??= once(trigger).finally(() => (running = null));
    return running;
  }

  async function stop(): Promise<void> {
    const was = live;
    live = null;
    if (!was) return;
    was.off();
    await deps.acp.stopSession?.(was.conversationId).catch(() => undefined);
  }

  return { run, stop, running: () => running !== null };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
