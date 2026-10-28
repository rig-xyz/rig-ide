import type { AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok, type Result } from '@emdash/shared';
import type { RigFeedCard } from '@shared/rig/feed';
import type { RawSessionEvent, SpacesAcpSessions } from '../spaces/dispatch';
import { askFirst, lockedSession } from './lockdown';
import type { TurnGate } from './turns';

/**
 * A card's Send or Post (onboarding Step 6): the person's click sends exactly
 * the words on the card, edited or not, to the place the card's draft names,
 * and nothing else.
 *
 * - Post (a GitHub pull request or issue): Rig comments itself with `gh`, the
 *   words on stdin. No model in the way.
 * - Send (Slack): a short session of the person's Claude, locked down like
 *   the orchestrator's (lockdown.ts), whose one permission allows
 *   `slack_send_message` once, and only with this channel, this thread and
 *   these exact words. The person's own allow rules don't apply in it, so
 *   even an allow rule for `slack_send_message` can't skip that check.
 *   It counts as sent only when that call completes.
 */

export type SendInput = { situationId: string; choice: number; text: string };
export type SendOutcome = { said: string; link: string | null };

export type SendDeps = {
  /** The card as the relay holds it now: its drafts and targets are the relay's, never the window's. */
  card(situationId: string): Promise<Result<RigFeedCard | null, { message: string }>>;
  /** `gh` with these arguments and this stdin; its stdout. */
  gh(args: string[], stdin: string): Promise<Result<string, { message: string }>>;
  acp: Pick<SpacesAcpSessions, 'startSession' | 'setConfig' | 'queuePrompt' | 'subscribeRaw' | 'subscribePendingPermissions' | 'resolvePermission' | 'stopSession'>;
  /** Where the Slack session runs: the Home space's folder. */
  cwd(): Promise<string>;
  newConversationId(): string;
  /** Tells Rig the card is acted on, so it leaves the Feed. */
  answered(situationId: string, choice: string): Promise<unknown>;
  turns: TurnGate;
  /** It went: sent or posted, and whether the words were changed from the draft (telemetry; never the words). */
  sent?: (what: { type: 'send' | 'post'; edited: boolean }) => void;
  timeoutMs?: number;
  log?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
};

const MAX_TEXT = 4000;
const SLACK_SEND = /^mcp__[A-Za-z0-9_]*Slack[A-Za-z0-9_]*__slack_send_message$/;

/** Where a draft goes: a Slack channel (and thread), or a GitHub pull request or issue. */
export function parseTarget(target: string): { kind: 'slack'; channel: string; thread: string | null } | { kind: 'github'; repo: string; number: string } | null {
  const slack = /^msg:slack:([A-Z0-9]+)(?::([0-9.]+))?$/.exec(target);
  if (slack) return { kind: 'slack', channel: slack[1]!, thread: slack[2] ?? null };
  const gh = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(target);
  if (gh) return { kind: 'github', repo: gh[1]!, number: gh[2]! };
  return null;
}

const same = (a: unknown, b: string) => typeof a === 'string' && a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();

/**
 * The Slack session's one permission: `slack_send_message`, once, with this
 * channel, this thread and these words. Anything else is refused.
 */
export function sendPermission(expect: { channel: string; thread: string | null; text: string }) {
  let used = false;
  return (request: AcpPermissionRequest): string | null => {
    const call = request.toolCall as { title?: string; rawInput?: Record<string, unknown> };
    const input = call.rawInput ?? {};
    const allowed =
      !used &&
      SLACK_SEND.test(call.title ?? '') &&
      input.channel_id === expect.channel &&
      (expect.thread ? input.thread_ts === expect.thread : !input.thread_ts) &&
      !input.reply_broadcast &&
      same(input.message, expect.text);
    if (allowed) used = true;
    return request.options.find((o) => o.kind === (allowed ? 'allow_once' : 'reject_once'))?.optionId ?? null;
  };
}

export function createSender(deps: SendDeps) {
  async function send(input: SendInput, userTurnId: string): Promise<Result<SendOutcome, string>> {
    if (!deps.turns.fresh(userTurnId)) return err('Sending needs your click.');
    const text = input.text.trim();
    if (!text) return err('There are no words to send.');
    if (text.length > MAX_TEXT) return err('That is too long to send in one go.');
    const card = await deps.card(input.situationId);
    if (!card.success) return err(card.error.message);
    const choice = card.data?.choices[input.choice];
    if (!choice || (choice.verb !== 'send' && choice.verb !== 'post') || !choice.draft) return err('This card has nothing to send any more.');
    const target = parseTarget(choice.draft.target);
    if (!target) return err("Rig can't send there yet.");
    const sent = target.kind === 'github' ? await postOnGitHub(target, text) : await sendInSlack(target, text);
    if (!sent.success) {
      // Not the error itself: Slack's or gh's answer can quote the words.
      deps.log?.warn('Rig send: did not go', { situationId: input.situationId, kind: target.kind, errorLength: sent.error.length });
      return sent;
    }
    await Promise.resolve(deps.answered(input.situationId, choice.label || choice.lead)).catch(() => undefined);
    deps.log?.info('Rig send: sent', { situationId: input.situationId, kind: target.kind });
    deps.sent?.({ type: choice.verb, edited: !same(text, choice.draft.text) });
    return sent;
  }

  async function postOnGitHub(target: { repo: string; number: string }, text: string): Promise<Result<SendOutcome, string>> {
    const r = await deps.gh(['issue', 'comment', target.number, '--repo', target.repo, '--body-file', '-'], text);
    if (!r.success) return err(r.error.message);
    const link = /https:\/\/github\.com\/\S+/.exec(r.data)?.[0] ?? null;
    return ok({ said: `Posted on ${target.repo.split('/')[1]}#${target.number}`, link });
  }

  async function sendInSlack(target: { channel: string; thread: string | null }, text: string): Promise<Result<SendOutcome, string>> {
    const conversationId = deps.newConversationId();
    const cwd = await deps.cwd();
    const started = await deps.acp.startSession({
      conversationId,
      providerId: 'claude',
      cwd,
      systemPromptAppend: 'You send one Slack message, word for word, for the person who clicked Send in Rig. Nothing else: no searching, reading, reacting or other messages.',
      ...lockedSession(),
    });
    if (!started.success) return err(started.error);
    try {
      const moded = await askFirst(deps.acp, conversationId);
      if (!moded.success) return err("Couldn't start a safe session to send it.");
      let finish!: (r: Result<SendOutcome, string>) => void;
      const done = new Promise<Result<SendOutcome, string>>((resolve) => (finish = resolve));
      let begun = false;
      let link: string | null = null;
      const calls = new Map<string, string>();
      const offRaw = await deps.acp.subscribeRaw(conversationId, (raw: RawSessionEvent) => {
        if (raw.kind === 'turn_start') begun = true;
        else if (raw.kind === 'acp_update') {
          const u = raw.update as { sessionUpdate: string; toolCallId?: string; name?: string; title?: string; status?: string; content?: unknown; rawOutput?: unknown };
          if (u.toolCallId && (u.name || u.title)) calls.set(u.toolCallId, u.name ?? u.title ?? '');
          if (u.sessionUpdate === 'tool_call_update' && u.toolCallId && SLACK_SEND.test(calls.get(u.toolCallId) ?? '')) {
            if (u.status === 'completed') {
              // Slack's reply ({"message_link": …}) comes back in rawOutput, its slashes escaped.
              const said = JSON.stringify([u.content, u.rawOutput]).replace(/\\+\//g, '/');
              link = /https:\/\/[\w.-]*slack\.com\/archives\/[^\s"'\\)\]]+/.exec(said)?.[0] ?? null;
              finish(ok({ said: target.thread ? 'Sent in the Slack thread' : 'Sent in Slack', link }));
            } else if (u.status === 'failed') finish(err(`Slack said no: ${JSON.stringify(u.content ?? u.rawOutput ?? '').slice(0, 300)}`));
          }
        } else if (raw.kind === 'turn_end' && begun) finish(err("Claude didn't send it."));
      });
      // One permission for the whole session: the send, once.
      const permit = sendPermission({ channel: target.channel, thread: target.thread, text });
      const offPerm = await deps.acp.subscribePendingPermissions(conversationId, (request) => {
        const optionId = permit(request);
        if (optionId) void deps.acp.resolvePermission(conversationId, request.requestId, optionId).catch(() => undefined);
      });
      const timer = setTimeout(() => finish(err('Sending took too long.')), deps.timeoutMs ?? 90_000);
      try {
        const where = `channel_id "${target.channel}"${target.thread ? ` and thread_ts "${target.thread}"` : ''}`;
        const prompt = [
          `Send exactly the message between the lines with slack_send_message, ${where}. Send it once, word for word, then stop.`,
          '---',
          text,
          '---',
        ].join('\n');
        const queued = await deps.acp.queuePrompt(conversationId, prompt, undefined, (reason) => finish(err(reason)));
        if (!queued.success) return err(queued.error);
        return await done;
      } finally {
        clearTimeout(timer);
        offRaw();
        offPerm();
      }
    } finally {
      await deps.acp.stopSession?.(conversationId).catch(() => undefined);
    }
  }

  return { send };
}
