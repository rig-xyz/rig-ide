import type { AcpHttpMcpServerWire, AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok, type Result } from '@emdash/shared';
import type { OrchAgentState } from '../feed/relay';
import { finalAnswerFromEvents, type RawSessionEvent, type SpacesAcpSessions } from '../spaces/dispatch';
import { RIG_TOOLS_SERVER } from '@shared/spaces/connectors';
import { ORCHESTRATOR_BINDING, ORCHESTRATOR_RIG_TOOLS, rigToolOf, type RigToolScope } from '../spaces/rig-tools';
import { ProgressMapper, type AcpToolUpdate, type OrchProgressEvent } from '@shared/rig/orch-progress';
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

/**
 * Tools the session can never use, whatever the person's own Claude settings
 * allow: no shell (GitHub reads go through rig_github), no file writes, and
 * no starting work. Deny rules beat allow rules, so this holds in code even
 * when nothing prompts.
 */
export const AGENT_DENIED_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', `mcp__${RIG_TOOLS_SERVER}__rig_start`];

/** The mode the session runs in: Claude Code's "Ask first", so every call the rules above don't settle comes to `agentPermission`. */
export const AGENT_MODE = 'default';

export const AGENT_BUDGET = { lookups: 20, firstRead: 40 };

/** Rig's own tools from the list above; connectors' read tools and `gh` reads (checks.ts); nothing else. */
export function agentPermission(request: AcpPermissionRequest): string | null {
  const tool = rigToolOf(request.toolCall.title);
  if (!tool) return checkPermission(request);
  const want = ORCHESTRATOR_RIG_TOOLS.has(tool) ? 'allow_once' : 'reject_once';
  return request.options.find((o) => o.kind === want)?.optionId ?? null;
}

/** What a run reads when the person hasn't set up sources: their connectors, by the names cursors use. */
const DEFAULT_SOURCES = [
  { name: 'slack', what: 'your DMs and the channels you are in' },
  { name: 'linear', what: 'issues you created, own or are mentioned in' },
  { name: 'github', what: 'pull requests and issues that wait on you, through rig_github' },
];

/** How a run reads: in one pass with the usual budget, or (the first run) in passes. */
export type RunOptions = {
  kind?: 'regular' | 'first';
  /** Each pass is one turn and one run row; `goal` says what it's for ("first card"). */
  passes?: { lookups: number; goal?: string }[];
  /** How far back a first read goes. */
  lookbackDays?: number;
};

/** The first run (onboarding Step 5): a quick pass for the first card while they watch, then the rest. */
export const FIRST_RUN: RunOptions = { kind: 'first', passes: [{ lookups: 12, goal: 'first card' }, { lookups: 40 }], lookbackDays: 3 };

/** When the first pass finds nothing in its lookback, it widens once to this. */
export const WIDENED_LOOKBACK_DAYS = 14;

/** Which pass of a first run a packet is for. */
export type FirstPass = { pass: number; of: number; lookups: number; goal: string | null; lookbackDays: number; widened: boolean };

export type PacketInput = {
  runId: string;
  now: number;
  trigger: string;
  state: OrchAgentState;
  /** What each of the person's sources watches: "Slack: your DMs and #eng-general". */
  sources: { connector: string; what: string }[];
  /** The first run's pass, when this is one. */
  first?: FirstPass;
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
  const first = p.first;
  // The first run reads every source from its lookback, whatever cursors an earlier try left.
  const since = first ? iso(p.now - first.lookbackDays * 86_400_000) : firstSince;
  const sourceLines = named.map((s) =>
    !first && state.cursors[s.name] ? `${s.name}: ${s.what}, since ${state.cursors[s.name]}` : `${s.name}: ${s.what}, ${first ? '' : 'never read: '}read since ${since}`
  );
  const firstRead = !first && fresh.length > 0;
  const lookups = first ? first.lookups : firstRead ? AGENT_BUDGET.firstRead : AGENT_BUDGET.lookups;
  return [
    // No user_turn_id: a run is never the person asking, so it can never pass rig_start's gate.
    `<run id="${p.runId}" now="${iso(p.now)}" trigger="${p.trigger}" budget="${lookups} lookups"/>`,
    '',
    '## Who you are',
    state.profile || state.me || 'Unknown: ask nothing, and note it in the run note.',
    '',
    '## Your rules',
    ...(state.rules.length ? state.rules.map((r) => `${r.ref} "${r.text}"`) : ['None yet.']),
    '',
    ...(first ? ['## First read', ...firstReadLines(first, state.me || 'them'), ''] : []),
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
    `As you settle each thing you read, report it with rig_run_note (run_id "${p.runId}") outcome: handled, not_yours or for_you.`,
    `End the ${first ? 'pass' : 'run'} with rig_run_note (run_id "${p.runId}") and its note, even when nothing changed. In read, name each source exactly as above (${named.map((s) => s.name).join(', ')}).`,
  ].join('\n');
}

/** The first run's own instructions, per pass: the first card fast, then the rest. */
function firstReadLines(f: FirstPass, me: string): string[] {
  const watching = `This is ${me}'s first run, and they are watching it: each lookup and each outcome you report shows as a line on their screen.`;
  if (f.pass === 1 || f.widened) {
    return [
      watching,
      f.widened
        ? `Pass ${f.pass} of ${f.of}, ${f.lookups} lookups. The last pass found nothing that needs ${me}: read the last ${f.lookbackDays} days once instead, the same way.`
        : `Pass ${f.pass} of ${f.of}, ${f.lookups} lookups: read the last ${f.lookbackDays} days across the sources below and find the one thing that most needs ${me} now.`,
      'Put its card the moment you have it (rig_feed put), with your best choices, before you read on; then end this pass. Never pad: no card is better than a weak one.',
    ];
  }
  return [
    watching,
    `Pass ${f.pass} of ${f.of}, ${f.lookups} lookups: keep reading the rest of the last ${f.lookbackDays} days. Put the other cards that need ${me} or that Claude can take, check the ones already on the Feed, and end the pass.`,
  ];
}

export type OrchestratorDeps = {
  acp: Pick<SpacesAcpSessions, 'startSession' | 'setConfig' | 'queuePrompt' | 'subscribeRaw' | 'subscribePendingPermissions' | 'resolvePermission' | 'stopSession'>;
  rigTools: (scope: RigToolScope) => Promise<AcpHttpMcpServerWire>;
  whoami: () => Promise<Result<{ id: string }, { message: string }>>;
  cwd: () => Promise<string>;
  newConversationId: () => string;
  state: () => Promise<Result<OrchAgentState, { message: string }>>;
  sources: () => Promise<{ connector: string; what: string }[]>;
  recordRun: (id: string, trigger: string, note?: Record<string, unknown>, pass?: number) => Promise<unknown>;
  now: () => number;
  /** Each step of a run as it happens (`ProgressMapper`): the Read step and its field show them. */
  onProgress?: (event: OrchProgressEvent) => void;
  turnTimeoutMs?: number;
  log?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
};

/** A progress event before the run's id is put on it. */
type ProgressBody = OrchProgressEvent extends infer E ? (E extends unknown ? Omit<E, 'run'> : never) : never;

export type RunResult = { runId: string; noted: boolean; ms: number; cards: number };

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
    // The person's own default model, as in their other sessions; never their permission mode or allow rules.
    const started = await deps.acp.startSession({
      conversationId,
      providerId: 'claude',
      cwd,
      mcpServers: [rig],
      systemPromptAppend: orchestratorSkill(name),
      disallowedTools: AGENT_DENIED_TOOLS,
      noBypassPermissions: true,
    });
    if (!started.success) return err(started.error);
    // Ask first, whatever the person's defaultMode: if it can't be set, no run.
    const moded = deps.acp.setConfig ? await deps.acp.setConfig(conversationId, { mode: AGENT_MODE }) : err('This build cannot set the session mode.');
    if (!moded.success) {
      await deps.acp.stopSession?.(conversationId).catch(() => undefined);
      return err(`Could not put the orchestrator in Ask first: ${moded.error}`);
    }
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

  /** Ids for a run and its passes: `run_<time>_<rand>`. */
  const newRunId = (at: number) => `run_${new Date(at).toISOString().replace(/\D/g, '').slice(0, 12)}_${Math.random().toString(36).slice(2, 6)}`;

  async function once(trigger: string, opts: RunOptions): Promise<Result<RunResult, string>> {
    const startedAt = deps.now();
    const first = opts.kind === 'first';
    const group = newRunId(startedAt);
    const t = () => deps.now() - startedAt;
    const emit = (e: ProgressBody) => deps.onProgress?.({ run: group, ...e } as OrchProgressEvent);
    const step = (id: string, label: string, status: 'running' | 'done' | 'failed') =>
      emit({ kind: 'line', line: { id: `step:${id}`, connector: null, label, status, t: t() } });
    const passes = first ? (opts.passes ?? FIRST_RUN.passes!) : [{ lookups: 0 }];
    const lookbackDays = opts.lookbackDays ?? 3;
    emit({ kind: 'start', trigger, passes: passes.length, lookups: passes.reduce((n, p) => n + p.lookups, 0), lookbackDays, t: 0 });
    // Said at once, so the person sees it working while the session wakes up.
    step('state', 'Looking up what Rig already knows', 'running');
    const state = await deps.state();
    if (!state.success) {
      step('state', 'Looking up what Rig already knows', 'failed');
      emit({ kind: 'end', ok: false, error: state.error.message, t: t() });
      return err(state.error.message);
    }
    step('state', 'Looking up what Rig already knows', 'done');
    step('session', 'Waking your Claude', 'running');
    const session = await ensure(state.data.me || 'the person');
    step('session', 'Waking your Claude', session.success ? 'done' : 'failed');
    if (!session.success) {
      emit({ kind: 'end', ok: false, error: session.error, t: t() });
      return session;
    }
    const mapper = new ProgressMapper(t);
    let firstRunId: string | null = null;
    let noted = true;
    let cards = 0;
    let widened = false;
    const plan: { lookups: number; goal?: string; lookbackDays: number; widened?: boolean }[] = passes.map((p) => ({ ...p, lookbackDays }));
    for (let i = 0; i < plan.length; i++) {
      const pass = plan[i]!;
      const fp: FirstPass | undefined = first
        ? { pass: i + 1, of: plan.length, lookups: pass.lookups, goal: pass.goal ?? null, lookbackDays: pass.lookbackDays, widened: pass.widened === true }
        : undefined;
      if (first) emit({ kind: 'pass', pass: i + 1, lookups: pass.lookups, goal: pass.goal ?? null, lookbackDays: pass.lookbackDays, t: t() });
      const ran = await onePass(session.data.conversationId, trigger, i === 0 ? state.data : null, fp, first ? i + 1 : undefined, mapper, emit);
      if (!ran.success) {
        emit({ kind: 'end', ok: false, error: ran.error, t: t() });
        return err(ran.error);
      }
      firstRunId ??= ran.data.runId;
      noted &&= ran.data.noted;
      cards += ran.data.cards;
      // Nothing for them in the first pass's days: read further back, once, before the rest.
      if (first && i === 0 && ran.data.cards === 0 && !widened && lookbackDays < WIDENED_LOOKBACK_DAYS) {
        widened = true;
        plan.splice(1, 0, { lookups: pass.lookups, goal: pass.goal, lookbackDays: WIDENED_LOOKBACK_DAYS, widened: true });
        for (const later of plan.slice(2)) later.lookbackDays = WIDENED_LOOKBACK_DAYS;
      }
    }
    emit({ kind: 'end', ok: true, t: t() });
    deps.log?.info('Rig orchestrator: run ended', { trigger, passes: plan.length, widened, cards, ms: t() });
    return ok({ runId: firstRunId!, noted, ms: t(), cards });
  }

  /** One turn of a run: its packet, its tool calls as progress, and its note (or one written for it). */
  async function onePass(
    conversationId: string,
    trigger: string,
    known: OrchAgentState | null,
    firstPass: FirstPass | undefined,
    passNo: number | undefined,
    mapper: ProgressMapper,
    emit: (e: ProgressBody) => void
  ): Promise<Result<RunResult, string>> {
    const startedAt = deps.now();
    let state = known;
    if (!state) {
      const fetched = await deps.state();
      if (!fetched.success) return err(fetched.error.message);
      state = fetched.data;
    }
    const runId = newRunId(startedAt);
    await deps.recordRun(runId, trigger, undefined, passNo);
    const packet = buildPacket({ runId, now: startedAt, trigger, state, sources: await deps.sources(), ...(firstPass ? { first: firstPass } : {}) });
    let finish!: (r: Result<null, string>) => void;
    const done = new Promise<Result<null, string>>((resolve) => (finish = resolve));
    let begun = false;
    let cards = 0;
    const events: { kind: string; payload: Record<string, unknown> }[] = [];
    const offRaw = await deps.acp.subscribeRaw(conversationId, (raw: RawSessionEvent) => {
      if (raw.kind === 'turn_start') begun = true;
      else if (raw.kind === 'acp_update' && begun) {
        events.push({ kind: raw.update.sessionUpdate, payload: raw.update });
        // A lookup that failed says why in the log (the person sees "Couldn't read").
        if (raw.update.sessionUpdate === 'tool_call_update' && (raw.update as { status?: string }).status === 'failed') {
          deps.log?.warn('Rig orchestrator: a lookup failed', { pass: passNo, call: JSON.stringify(raw.update).slice(0, 800) });
        }
        for (const e of mapper.push(raw.update as AcpToolUpdate)) {
          if (e.kind === 'card') cards += 1;
          emit(e);
        }
      } else if (raw.kind === 'turn_end' && begun) finish(ok(null));
    });
    const timer = setTimeout(() => finish(err('The run took too long.')), deps.turnTimeoutMs ?? 10 * 60_000);
    try {
      const queued = await deps.acp.queuePrompt(conversationId, packet, undefined, (reason) => finish(err(reason)));
      if (!queued.success) return err(queued.error);
      const ended = await done;
      // The relay's latest noted run is this one only if the pass ended with rig_run_note.
      const after = await deps.state();
      const noted = after.success && after.data.lastRun?.id === runId;
      const said = finalAnswerFromEvents(events).trim();
      if (!noted) {
        // No note: keep the cursors where they were, so the next run reads from the same place.
        await deps.recordRun(runId, trigger, {
          read: Object.entries(state.cursors).map(([source, until]) => ({ source, until })),
          changed: [],
          left: [],
          summary: ended.success ? `The run ended without a note. Claude's last words: ${said.slice(0, 600) || '(none)'}` : `The run failed: ${ended.error}`,
        });
      }
      deps.log?.info('Rig orchestrator: pass ended', { runId, trigger, pass: passNo, noted, cards, ms: deps.now() - startedAt, ok: ended.success, said: said.slice(0, 600) });
      return ended.success ? ok({ runId, noted, ms: deps.now() - startedAt, cards }) : err(ended.error);
    } finally {
      clearTimeout(timer);
      offRaw();
    }
  }

  /**
   * One run, now. A regular run asked for while one runs joins it; the first
   * run waits for the one going and then runs, since it reads in its own passes.
   */
  function run(trigger: string, opts: RunOptions = {}): Promise<Result<RunResult, string>> {
    if (running && opts.kind !== 'first') return running;
    const before = running;
    const next = (before ? before.then(() => undefined, () => undefined) : Promise.resolve()).then(() => once(trigger, opts));
    const tracked: Promise<Result<RunResult, string>> = next.finally(() => {
      if (running === tracked) running = null;
    });
    running = tracked;
    return tracked;
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
