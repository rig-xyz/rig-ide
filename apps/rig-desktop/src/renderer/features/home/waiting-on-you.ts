/**
 * "Waiting on you" on Home (Dylan, Home "lighter pass"): only direct,
 * unread things, each with the one action it needs. Your unread mentions
 * and replies (Reply, inline), invites to a space (Accept), and your own
 * agents waiting on your approval (Approve, from this computer's own copy
 * of the run; Open when the run isn't here). Pure; the section draws it.
 */

import type { RigNotification } from '@shared/rig/notifications';
import type { RigSpaceAgent, RigSpaceStatus } from '@shared/rig/space-status';
import type { LocalRunEvent } from '@shared/spaces/room-sees';
import { agentLabel } from './space-status-state';

export type WaitingItem =
  | {
      kind: 'reply';
      key: string;
      notificationId: string;
      bindingId: string;
      spaceName: string;
      /**
       * Who wrote it. For an agent, `name` is "Hugo's Claude", `agent` its
       * kind and `owner` the person whose agent it is.
       */
      who: { userId: string | null; name: string; agent?: RigSpaceAgent | null; owner?: string | null };
      verb: 'mentioned you' | 'replied to you';
      quote: string;
      messageId: string | null;
      messageSeq: number | null;
      /** A comment on a file: answered where it is, so the action is Open. */
      path: string | null;
      at: string;
    }
  | {
      kind: 'invite';
      key: string;
      inviteId: string;
      bindingId: string;
      spaceName: string;
      who: { userId: null; name: string };
      at: string;
    }
  | {
      kind: 'approval';
      key: string;
      runId: string;
      bindingId: string;
      spaceName: string;
      agent: string;
      agentKind: RigSpaceAgent;
      /** What it asks to do, when the run said. */
      title: string | null;
      at: string;
    };

export type WaitingAction = 'Reply' | 'Accept' | 'Approve' | 'Open';

export function deriveWaitingItems(input: {
  activity: readonly RigNotification[] | null;
  invites: readonly { id: string; bindingId: string; rigName: string; inviterLabel: string; createdAt: string }[];
  spaces: readonly { bindingId: string; name: string | null }[];
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  selfUserId: string | null;
}): WaitingItem[] {
  const nameOf = (bindingId: string) => input.spaces.find((s) => s.bindingId === bindingId)?.name ?? null;
  const items: WaitingItem[] = [];
  for (const n of input.activity ?? []) {
    if (n.readAt || !n.bindingId || (n.type !== 'mention' && n.type !== 'reply')) continue;
    items.push({
      kind: 'reply',
      key: `n:${n.id}`,
      notificationId: n.id,
      bindingId: n.bindingId,
      spaceName: n.spaceName ?? nameOf(n.bindingId) ?? 'a space',
      who: {
        userId: n.actor.userId,
        name:
          n.actor.kind === 'agent' && n.actor.agent
            ? `${n.actor.name ?? 'Someone'}'s ${agentLabel(n.actor.agent)}`
            : (n.actor.name ?? (n.actor.kind === 'guest' ? 'A guest' : 'Someone')),
        ...(n.actor.kind === 'agent' && n.actor.agent ? { agent: n.actor.agent, owner: n.actor.name } : {}),
      },
      verb: n.type === 'mention' ? 'mentioned you' : 'replied to you',
      quote: n.body,
      messageId: n.messageId,
      messageSeq: n.messageSeq,
      path: n.path,
      at: n.createdAt,
    });
  }
  for (const invite of input.invites) {
    items.push({
      kind: 'invite',
      key: `i:${invite.id}`,
      inviteId: invite.id,
      bindingId: invite.bindingId,
      spaceName: invite.rigName,
      who: { userId: null, name: invite.inviterLabel },
      at: invite.createdAt,
    });
  }
  if (input.selfUserId) {
    for (const space of input.spaces) {
      const status = input.statusByBinding.get(space.bindingId);
      for (const run of status?.running ?? []) {
        if (run.activity !== 'waiting' || run.ownerUserId !== input.selfUserId) continue;
        items.push({
          kind: 'approval',
          key: `r:${run.runId}`,
          runId: run.runId,
          bindingId: space.bindingId,
          spaceName: space.name ?? 'a space',
          agent: agentLabel(run.agent),
          agentKind: run.agent,
          title: run.title ?? null,
          at: run.startedAt,
        });
      }
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

export type PendingRequest = {
  requestId: string;
  title: string | null;
  options: { optionId: string; name: string; kind: string }[];
};

/**
 * The newest approval a run is still waiting on, from this computer's own
 * copy of it (`localRunEvents`): a `permission_requested` with no
 * `permission_decided` after it. Null when there's none, or no copy here.
 */
export function pendingRequestOf(events: readonly LocalRunEvent[] | null): PendingRequest | null {
  if (!events) return null;
  const decided = new Set(
    events
      .filter((e) => e.kind === 'permission_decided')
      .map((e) => (typeof e.payload.requestId === 'string' ? e.payload.requestId : ''))
  );
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== 'permission_requested') continue;
    const toolCall = (e.payload.toolCall ?? null) as Record<string, unknown> | null;
    const requestId =
      typeof e.payload.requestId === 'string'
        ? e.payload.requestId
        : typeof toolCall?.toolCallId === 'string'
          ? toolCall.toolCallId
          : null;
    if (!requestId || decided.has(requestId)) continue;
    const options = Array.isArray(e.payload.options)
      ? e.payload.options.flatMap((o: unknown) => {
          const opt = o as Record<string, unknown> | null;
          return opt && typeof opt.optionId === 'string'
            ? [{ optionId: opt.optionId, name: typeof opt.name === 'string' ? opt.name : opt.optionId, kind: typeof opt.kind === 'string' ? opt.kind : '' }]
            : [];
        })
      : [];
    return { requestId, title: typeof toolCall?.title === 'string' ? toolCall.title : null, options };
  }
  return null;
}

/** The one thing to do about an item. */
export function waitingAction(item: WaitingItem, ctx: { approvable: boolean }): WaitingAction {
  switch (item.kind) {
    case 'reply':
      return item.path || !item.messageId ? 'Open' : 'Reply';
    case 'invite':
      return 'Accept';
    case 'approval':
      return ctx.approvable ? 'Approve' : 'Open';
  }
}

/** What an item says once its action went through, before it clears. */
export function doneLine(item: WaitingItem): string {
  switch (item.kind) {
    case 'reply':
      return `Replied in #${item.spaceName}.`;
    case 'invite':
      return `You joined #${item.spaceName}.`;
    case 'approval':
      return `Approved. ${item.agent} is back at work in #${item.spaceName}.`;
  }
}

/**
 * The message before the one quoted, as context: who wrote it and a short
 * excerpt on one line ("Hugo: looks like: a mandatory onboarding call").
 * Markdown list marks and line breaks are flattened out of it.
 */
export function contextLine(prev: { authorName: string | null; body: string } | null): string | null {
  if (!prev) return null;
  const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/;
  const lines = prev.body
    .split('\n')
    .map((line) => ({ item: LIST_MARK.test(line), text: line.replace(LIST_MARK, '').trim() }))
    .filter((line) => line.text);
  // List items read as a list: "a, b, c".
  const flat = lines
    .map((line, i) => (i > 0 ? (line.item && lines[i - 1]!.item ? ', ' : ' ') : '') + line.text)
    .join('')
    .replace(/\s+/g, ' ');
  if (!flat) return null;
  const excerpt = flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
  return `${prev.authorName?.trim().split(/\s+/)[0] || 'Someone'}: ${excerpt}`;
}
