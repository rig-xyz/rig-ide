import type { AcpHttpMcpServerWire, AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok, type Result } from '@emdash/shared';
import { finalAnswerFromEvents, type RawSessionEvent, type SpacesAcpSessions } from '../spaces/dispatch';
import { rigToolOf, type RigToolScope } from '../spaces/rig-tools';

/**
 * Home's chat with a real Claude (rig docs/orchestrator-architecture.md §5):
 * one Claude session on this Mac, in an empty folder of its own, with Rig's
 * tools attached so it can read the person's Feed and correct it. The person
 * typed the request here, so the Feed tools are answered for them; anything
 * else Claude asks to run (files, shell, other rig tools) is refused, since
 * Home isn't a space and has nothing to work on yet.
 */

/** The rig tools Home's Claude may use, without asking again: the Feed's. */
export const HOME_CHAT_TOOLS: ReadonlySet<string> = new Set([
  'rig_feed_list',
  'rig_situation_explain',
  'rig_feed_hide',
  'rig_situation_merge',
  'rig_event_move',
]);

export const HOME_CHAT_RULES = [
  "You are Rig, talking with the person in their Home: the place they ask Rig about their work across their spaces. Rig's Feed is what Rig puts in front of them: cards for things that need them or that their Claude could do, and situations Rig follows for them.",
  'Answer in a few plain sentences. Name cards by their title, never by an id.',
  'When they ask what needs them, what is in their Feed or what came in, read it with rig_feed_list.',
  "When they ask why something is there, read it with rig_situation_explain and say why in their terms.",
  "When they say a card is wrong because it doesn't need them, is already handled, is the same thing as another card, or holds an event about something else, read it with rig_situation_explain first, then fix it with rig_feed_hide, rig_situation_merge or rig_event_move. Give the reason in their words, then say what you changed.",
  "Use only those tools. You can't start sessions, open files or change anything else from Home yet; say so if they ask.",
].join('\n');

export type HomeChatDeps = {
  acp: Pick<
    SpacesAcpSessions,
    'startSession' | 'queuePrompt' | 'subscribeRaw' | 'subscribePendingPermissions' | 'resolvePermission' | 'stopSession'
  >;
  rigTools: (scope: RigToolScope) => Promise<AcpHttpMcpServerWire>;
  /** The signed-in account's relay user id: the rig tools only run for their owner. */
  whoami: () => Promise<Result<{ id: string }, { message: string }>>;
  /** Home's own empty folder, where the session runs. */
  cwd: () => Promise<string>;
  newConversationId: () => string;
  turnTimeoutMs?: number;
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
};

export type HomeChat = {
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
  let live: { conversationId: string; ownerUserId: string; off: () => void } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function ensureSession(): Promise<Result<{ conversationId: string }, string>> {
    const me = await deps.whoami();
    if (!me.success) return err(me.error.message);
    if (live && live.ownerUserId === me.data.id) return ok({ conversationId: live.conversationId });
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
      systemPromptAppend: HOME_CHAT_RULES,
    });
    if (!started.success) return err(started.error);
    const off = await deps.acp.subscribePendingPermissions(conversationId, (request) => {
      const optionId = homeChatPermission(request);
      if (!optionId) return;
      deps.acp.resolvePermission(conversationId, request.requestId, optionId).catch((error: unknown) => {
        deps.log?.warn('Home chat: could not answer a permission request', { error: String(error) });
      });
    });
    live = { conversationId, ownerUserId: me.data.id, off };
    return ok({ conversationId });
  }

  async function turn(text: string): Promise<Result<{ text: string }, string>> {
    const session = await ensureSession();
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
      const queued = await deps.acp.queuePrompt(conversationId, text, undefined, (reason) => finish(err(reason)));
      if (!queued.success) return err(queued.error);
      return await done;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  async function reset(): Promise<void> {
    const was = live;
    live = null;
    if (!was) return;
    was.off();
    await deps.acp.stopSession?.(was.conversationId);
  }

  return {
    send(text) {
      const next = queue.then(() => turn(text));
      queue = next.catch(() => undefined);
      return next;
    },
    reset,
  };
}
