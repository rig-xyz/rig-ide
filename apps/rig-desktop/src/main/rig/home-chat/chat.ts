import type { AcpHttpMcpServerWire, AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok, type Result } from '@emdash/shared';
import { finalAnswerFromEvents, type RawSessionEvent, type SpacesAcpSessions } from '../spaces/dispatch';
import type { HomeChatRun } from '@shared/rig/home-chat';
import { rigToolOf, type RigToolScope } from '../spaces/rig-tools';

/**
 * Home's chat with a real Claude (rig docs/orchestrator-architecture.md §5):
 * one Claude session on this Mac, in an empty folder of its own, with Rig's
 * tools attached so it can read the person's Feed and correct it. The person
 * typed the request here, so the Feed tools are answered for them; anything
 * else Claude asks to run (files, shell, other rig tools) is refused, since
 * Home isn't a space and has nothing to work on yet.
 */

/** The rig tools Home's Claude may use without asking again: the four primitives (design §10.3). */
export const HOME_CHAT_TOOLS: ReadonlySet<string> = new Set(['rig_query', 'rig_get', 'rig_act', 'rig_start']);

export const HOME_CHAT_RULES = [
  "You are Rig, talking with the person in their Home: the place they ask Rig about their work across their spaces and tell it what to do. Rig's Feed is what Rig puts in front of them: cards for things that need them or that their Claude could do; what Rig held back stays out of sight until they ask.",
  'You have four tools. rig_query lists anything as numbered rows with refs (feed, held, items, topics, sources, connectors, spaces, sessions, rules, changes). rig_get reads one ref in full, including why it is or is not in the Feed. rig_act changes Rig\'s state. rig_start starts a session that does work.',
  'Compose them: "what needs me" is rig_query feed with filter {"needs":"me"}; "what\'s in my inbox" is items since a day plus topics, grouped for them; "my connectors" is connectors plus sources; "run the sync again" is sources, then rig_act run_now on the right one (ask first if "sync" could mean file sync); "dismiss these two" is rig_act ignore on the two rows they mean.',
  'Feed rows have a state: "visible" cards are the ones the person sees on the right, "queued" ones wait behind them. Answer from the visible cards, in order, and only say how many more are queued.',
  'Number every list you show. "These two", "the first one" and the like mean rows of the last list you showed; if it is ambiguous, ask.',
  "Pass the person's reason, in their words, as args.reason. After a change, say what changed and give its change ref so they can undo it with rig_act undo.",
  "Actions that speak for them, involve other people or can't be undone come back as a card: say it needs their click; nothing has happened.",
  'To start work, call rig_start with the task or a card ref and the user_turn_id from this turn\'s <rig_turn> line. If Rig asks which space, ask them.',
  'Answer in a few plain sentences. Name cards by their title, never by an id alone. You have no shell and no files here.',
].join('\n');

/** Who Home's Claude is talking to: Rig's data names them like anyone else, so it must know which name is "you". */
export function homeChatSelf(names: string[]): string {
  const known = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (!known.length) return '';
  return `You are talking with ${known[0]}. In Rig's data (cards, messages, tickets, PRs) they appear as ${known.join(' or ')}${known.some((n) => n.includes(' ')) ? ', or by first name' : ''}: that is them, not someone else. Talk to them as "you" ("you approved #340"), never by their name or in the third person.`;
}

export type HomeChatDeps = {
  acp: Pick<
    SpacesAcpSessions,
    'startSession' | 'queuePrompt' | 'subscribeRaw' | 'subscribePendingPermissions' | 'resolvePermission' | 'stopSession' | 'cancelTurn' | 'readModel'
  >;
  /** The names that mean the person: their account name, and how Rig names them. */
  selfNames?: () => Promise<string[]>;
  rigTools: (scope: RigToolScope) => Promise<AcpHttpMcpServerWire>;
  /** The signed-in account's relay user id: the rig tools only run for their owner. */
  whoami: () => Promise<Result<{ id: string }, { message: string }>>;
  /** Home's own empty folder, where the session runs. */
  cwd: () => Promise<string>;
  newConversationId: () => string;
  /** A fresh user_turn_id for the person's message (orch/turns.ts); rig_start checks it. */
  issueTurn: () => string;
  turnTimeoutMs?: number;
  /** A run changed; the renderer redraws its card. */
  onRun?: (run: HomeChatRun) => void;
  now?: () => number;
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
};

export type HomeChat = {
  /** Starts Home's session if it isn't running, so the renderer can show it live (the spaces transcript). */
  open(): Promise<Result<{ conversationId: string; cwd: string }, string>>;
  /** The hidden line for one of the person's messages: a fresh user_turn_id that rig_start checks. */
  turnContext(): string;
  /** Sends one of the person's messages as a new run; its updates arrive through `onRun`. */
  ask(text: string): Promise<Result<{ runId: string }, string>>;
  /** Stops the running turn. */
  stop(): Promise<void>;
  /** This conversation's runs, oldest first. */
  runs(): HomeChatRun[];
  /** One turn: resolves with Claude's answer once the turn ends. Turns run one at a time. */
  send(text: string): Promise<Result<{ text: string }, string>>;
  /** Forget the conversation; the next message starts a new one. */
  reset(): Promise<void>;
};

/** Answers a permission request: allow once for the Feed tools, refuse anything else. */
export function homeChatPermission(request: AcpPermissionRequest): string | null {
  const tool = rigToolOf(request.toolCall.title);
  const want = tool && HOME_CHAT_TOOLS.has(tool) ? 'allow_once' : 'reject_once';
  return request.options.find((o) => o.kind === want)?.optionId ?? null;
}

const TURN_TIMEOUT_MS = 3 * 60_000;

export function createHomeChat(deps: HomeChatDeps): HomeChat {
  let live: { conversationId: string; ownerUserId: string; cwd: string; off: () => void } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  // Two opens at once (Home mounting while a message is sent) must not start two sessions.
  let opening: Promise<Result<{ conversationId: string; cwd: string }, string>> | null = null;
  function open(): Promise<Result<{ conversationId: string; cwd: string }, string>> {
    opening ??= ensureSession().finally(() => (opening = null));
    return opening;
  }

  async function ensureSession(): Promise<Result<{ conversationId: string; cwd: string }, string>> {
    const me = await deps.whoami();
    if (!me.success) return err(me.error.message);
    if (live && live.ownerUserId === me.data.id) return ok({ conversationId: live.conversationId, cwd: live.cwd });
    if (live) await reset();
    const cwd = await deps.cwd();
    const conversationId = deps.newConversationId();
    const scope: RigToolScope = { bindingId: 'home', ownerUserId: me.data.id, agent: 'claude', cwd };
    const rig = await deps.rigTools(scope);
    const started = await deps.acp.startSession({
      conversationId,
      providerId: 'claude',
      cwd,
      mcpServers: [rig],
      // The person's own default model, as in their other Claude sessions.
      systemPromptAppend: [HOME_CHAT_RULES, homeChatSelf((await deps.selfNames?.().catch(() => [])) ?? [])].filter(Boolean).join('\n'),
    });
    if (!started.success) return err(started.error);
    const off = await deps.acp.subscribePendingPermissions(conversationId, (request) => {
      const optionId = homeChatPermission(request);
      if (!optionId) return;
      deps.acp.resolvePermission(conversationId, request.requestId, optionId).catch((error: unknown) => {
        deps.log?.warn('Home chat: could not answer a permission request', { error: String(error) });
      });
    });
    const offRaw = await deps.acp.subscribeRaw(conversationId, record);
    live = {
      conversationId,
      ownerUserId: me.data.id,
      cwd,
      off: () => {
        off();
        offRaw();
      },
    };
    return ok({ conversationId, cwd });
  }

  async function turn(text: string): Promise<Result<{ text: string }, string>> {
    const session = await open();
    if (!session.success) return session;
    const { conversationId } = session.data;
    const events: { kind: string; payload: Record<string, unknown> }[] = [];
    let finish!: (r: Result<{ text: string }, string>) => void;
    const done = new Promise<Result<{ text: string }, string>>((resolve) => (finish = resolve));
    let started = false;
    const unsubscribe = await deps.acp.subscribeRaw(conversationId, (raw: RawSessionEvent) => {
      if (raw.kind === 'turn_start') started = true;
      else if (raw.kind === 'acp_update') events.push({ kind: raw.update.sessionUpdate, payload: raw.update });
      else if (raw.kind === 'turn_end' && started) {
        const answer = finalAnswerFromEvents(events).trim();
        finish(answer ? ok({ text: answer }) : err(raw.stopReason === 'cancelled' ? 'Stopped.' : 'Claude had nothing to say.'));
      }
    });
    const timer = setTimeout(() => finish(err('Claude took too long to answer.')), deps.turnTimeoutMs ?? TURN_TIMEOUT_MS);
    try {
      const hidden = turnContext();
      const queued = await deps.acp.queuePrompt(conversationId, text, hidden, (reason) => finish(err(reason)));
      if (!queued.success) return err(queued.error);
      return await done;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  // ────────── runs: the person's messages and what Claude did with each ──────────

  const now = () => deps.now?.() ?? Date.now();
  let runs: HomeChatRun[] = [];
  let seq = 0;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<HomeChatRun>();
  /** Streamed text arrives a few words at a time: tell the renderer at most every 80ms. */
  function changed(run: HomeChatRun, now = false): void {
    pending.add(run);
    const flush = () => {
      pushTimer = null;
      for (const r of pending) deps.onRun?.({ ...r, events: [...r.events] });
      pending.clear();
    };
    if (now) {
      if (pushTimer) clearTimeout(pushTimer);
      flush();
    } else pushTimer ??= setTimeout(flush, 80);
  }
  const current = () => runs.find((r) => r.status === 'running') ?? null;

  function record(raw: RawSessionEvent): void {
    const run = current();
    if (!run) return;
    if (raw.kind === 'acp_update') {
      if (raw.update.sessionUpdate === 'available_commands_update' || raw.update.sessionUpdate === 'user_message_chunk') return;
      run.events.push({ seq: ++seq, kind: raw.update.sessionUpdate, payload: raw.update as Record<string, unknown> });
      changed(run);
    } else if (raw.kind === 'turn_end') {
      const status = raw.stopReason === 'cancelled' ? 'stopped' : raw.stopReason === 'refusal' ? 'failed' : 'done';
      run.events.push({ seq: ++seq, kind: 'turn_ended', payload: { status } });
      run.status = status;
      run.endedAt = new Date(now()).toISOString();
      changed(run, true);
    }
  }

  async function ask(text: string): Promise<Result<{ runId: string }, string>> {
    const session = await open();
    if (!session.success) return session;
    const model = (await deps.acp.readModel?.(session.data.conversationId).catch(() => null)) ?? '';
    const run: HomeChatRun = { id: `home-run-${++seq}`, prompt: text, at: new Date(now()).toISOString(), status: 'running', endedAt: null, model, events: [] };
    // Shown in the card header, as a space's runs do.
    if (model) run.events.push({ seq: ++seq, kind: 'run_model', payload: { model } });
    runs = [...runs, run];
    changed(run, true);
    const fail = (reason: string) => {
      if (run.status !== 'running') return;
      run.events.push({ seq: ++seq, kind: 'turn_ended', payload: { status: 'failed', reason } });
      run.status = 'failed';
      run.endedAt = new Date(now()).toISOString();
      changed(run, true);
    };
    const queued = await deps.acp.queuePrompt(session.data.conversationId, text, turnContext(), fail);
    if (!queued.success) {
      fail(queued.error);
      return err(queued.error);
    }
    return ok({ runId: run.id });
  }

  async function stop(): Promise<void> {
    if (live && current()) await deps.acp.cancelTurn(live.conversationId);
  }

  const turnContext = () => `<rig_turn user_turn_id="${deps.issueTurn()}" />`;

  async function reset(): Promise<void> {
    const was = live;
    live = null;
    runs = [];
    if (!was) return;
    was.off();
    await deps.acp.stopSession?.(was.conversationId);
  }

  return {
    open,
    turnContext,
    ask,
    stop,
    runs: () => runs.map((r) => ({ ...r, events: [...r.events] })),
    send(text) {
      const next = queue.then(() => turn(text));
      queue = next.catch(() => undefined);
      return next;
    },
    reset,
  };
}
