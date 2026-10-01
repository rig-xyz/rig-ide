import { defineEvent } from '../lib/ipc/events';

/**
 * Notifications (rig `docs/notifications-spec.md`). The relay decides who
 * is told about what and writes one row per recipient (tap
 * `packages/relay/src/notify/`); this app listens on the user's stream,
 * decides whether a row becomes a macOS banner, and keeps the Dock badge
 * and the rail's unread counts.
 *
 * Everything here is pure and shared by main (the presenter, the badge)
 * and the renderer (settings, badges, Activity).
 */

export type NotificationLevel = 'all' | 'mentions' | 'nothing';
export const NOTIFICATION_LEVELS: readonly NotificationLevel[] = ['all', 'mentions', 'nothing'];

export type NotificationType =
  | 'mention'
  | 'reply'
  | 'message'
  | 'comment'
  | 'agent_finished'
  | 'agent_waiting'
  | 'agent_request'
  | 'invite'
  | 'reaction';

export type NotificationTier = 'direct' | 'ambient';

/** One row of `GET /v1/me/notifications`. */
export type RigNotification = {
  id: string;
  type: NotificationType;
  tier: NotificationTier;
  /** `null` for invites: the invitee isn't a member of the space yet. */
  bindingId: string | null;
  /** The space's name when it happened (invites included). */
  spaceName: string | null;
  actor: {
    kind: 'user' | 'agent' | 'guest';
    userId: string | null;
    name: string | null;
    agent: 'claude' | 'codex' | null;
  };
  messageId: string | null;
  messageSeq: number | null;
  runId: string | null;
  requestId: string | null;
  inviteId: string | null;
  path: string | null;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

export type RigNotificationSpaceSummary = {
  bindingId: string;
  level: NotificationLevel;
  lastReadSeq: number;
  /** Room messages past the read cursor, not yours, capped at 100. */
  spaceUnread: number;
  /** Unread rows about you (mentions, replies, your agent, requests). */
  directUnread: number;
  /** The part of `directUnread` with no message: runs and requests. */
  directUnreadNoMessage: number;
};

/** `GET /v1/me/notifications/summary`. */
export type RigNotificationSummary = {
  spaces: RigNotificationSpaceSummary[];
  invitesUnread: number;
  directUnreadTotal: number;
};

export const EMPTY_NOTIFICATION_SUMMARY: RigNotificationSummary = {
  spaces: [],
  invitesUnread: 0,
  directUnreadTotal: 0,
};

/** The per-type switches in Settings › Notifications. Reactions aren't offered in v1. */
export type NotificationToggle =
  | 'mention'
  | 'reply'
  | 'agent_finished'
  | 'agent_waiting'
  | 'agent_request'
  | 'message'
  | 'comment'
  | 'invite';

export const NOTIFICATION_TOGGLES: readonly NotificationToggle[] = [
  'mention',
  'reply',
  'agent_finished',
  'agent_waiting',
  'agent_request',
  'message',
  'comment',
  'invite',
];

/** This computer's delivery preferences (rig settings; the space level lives on the relay). */
export type NotificationPrefs = {
  /** Master switch for desktop banners. */
  enabled: boolean;
  /** No banners while a rig window is focused. */
  onlyWhenAway: boolean;
  sound: boolean;
  dockBadge: boolean;
  types: Record<NotificationToggle, boolean>;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  onlyWhenAway: true,
  sound: true,
  dockBadge: true,
  types: {
    mention: true,
    reply: true,
    agent_finished: true,
    agent_waiting: true,
    agent_request: true,
    message: true,
    comment: true,
    invite: true,
  },
};

/** A row this old when it first reaches this computer is "missed": counted, never bannered. */
export const STALE_BANNER_MS = 10 * 60 * 1000;
/** A new ambient row within this window of the last banner for its space replaces that banner. */
export const BUNDLE_WINDOW_MS = 30 * 1000;

export function normalizeNotificationPrefs(raw: unknown): NotificationPrefs {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const types = typeof r.types === 'object' && r.types !== null ? (r.types as Record<string, unknown>) : {};
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const out: NotificationPrefs = {
    enabled: bool(r.enabled, DEFAULT_NOTIFICATION_PREFS.enabled),
    onlyWhenAway: bool(r.onlyWhenAway, DEFAULT_NOTIFICATION_PREFS.onlyWhenAway),
    sound: bool(r.sound, DEFAULT_NOTIFICATION_PREFS.sound),
    dockBadge: bool(r.dockBadge, DEFAULT_NOTIFICATION_PREFS.dockBadge),
    types: { ...DEFAULT_NOTIFICATION_PREFS.types },
  };
  for (const key of NOTIFICATION_TOGGLES) out.types[key] = bool(types[key], DEFAULT_NOTIFICATION_PREFS.types[key]);
  return out;
}

/**
 * The Dock badge: unread rows about you (mentions, replies, your agent,
 * requests to it, invites), the same number the Activity bell shows, in
 * every space whatever its level. Plain new messages show on each space's
 * row on Home, not here: a count of every message in a busy space never
 * goes down. Dylan, 2026-10-01: "It needs to be consistent."
 */
export function dockCount(summary: RigNotificationSummary): number {
  return summary.directUnreadTotal;
}

export type BannerContext = {
  prefs: NotificationPrefs;
  /** The row's space level; `undefined` when unknown (treated as 'all'). */
  level: NotificationLevel | undefined;
  /** Any rig window has focus. */
  appFocused: boolean;
  /** The space currently on screen in a focused window, if any. */
  viewingBindingId: string | null;
  now: number;
};

export type BannerDecision =
  | { show: true }
  | {
      show: false;
      reason: 'disabled' | 'type' | 'read' | 'stale' | 'muted' | 'viewing' | 'present';
    };

/** Whether a newly received row becomes a banner (spec §5, presenter). */
export function decideBanner(n: RigNotification, ctx: BannerContext): BannerDecision {
  if (!ctx.prefs.enabled) return { show: false, reason: 'disabled' };
  const toggle = n.type === 'reaction' ? null : (n.type as NotificationToggle);
  if (!toggle || !ctx.prefs.types[toggle]) return { show: false, reason: 'type' };
  if (n.readAt) return { show: false, reason: 'read' };
  if (ctx.now - Date.parse(n.createdAt) > STALE_BANNER_MS) return { show: false, reason: 'stale' };
  if (n.bindingId && ctx.level === 'nothing') return { show: false, reason: 'muted' };
  if (n.bindingId && ctx.appFocused && ctx.viewingBindingId === n.bindingId) {
    return { show: false, reason: 'viewing' };
  }
  // Away means no rig window is focused (Dylan, 2026-10-01: focus only, no
  // idle timer; simpler to predict).
  if (ctx.prefs.onlyWhenAway && ctx.appFocused) {
    return { show: false, reason: 'present' };
  }
  return { show: true };
}

/** Where a banner or Activity click takes you. */
export type OpenSpaceAt = {
  bindingId: string;
  /** For what the app says while it sets a space up that isn't on this computer yet. */
  spaceName?: string | null;
  messageId?: string | null;
  /** The message's seq, so the Room can tell "too far back to show" from "not loaded yet". */
  messageSeq?: number | null;
  runId?: string | null;
  path?: string | null;
};

export function openTargetOf(n: RigNotification): OpenSpaceAt | null {
  if (!n.bindingId) return null;
  return {
    bindingId: n.bindingId,
    spaceName: n.spaceName,
    messageId: n.messageId,
    messageSeq: n.messageSeq,
    runId: n.runId,
    path: n.path,
  };
}

const AGENT_LABEL = { claude: 'Claude', codex: 'Codex' } as const;

/**
 * A direct row in a few words, for a space row's status line on Home
 * ("Hugo mentioned you"): the space is already named by the row, so this is
 * the relay's title without its "in <space>".
 */
export function directPhrase(n: RigNotification): string {
  // First name: the line is short, and the row already says which space.
  const who = n.actor.name?.trim().split(/\s+/)[0] || (n.actor.kind === 'guest' ? 'A guest' : 'Someone');
  const agent = n.actor.agent ? AGENT_LABEL[n.actor.agent] : 'Your agent';
  switch (n.type) {
    case 'mention':
      return `${who} mentioned you`;
    case 'reply':
      return `${who} replied to you`;
    case 'comment':
      return `${who} commented on your link`;
    case 'agent_request':
      return `${who} asked your ${agent}`;
    case 'agent_waiting':
      return `${agent} needs your approval`;
    case 'agent_finished':
      return `${agent} finished`;
    default:
      return n.title;
  }
}

/** Main → renderer: the summary or the rows changed; refetch. */
export const rigNotificationsChangedChannel = defineEvent<{ reason: 'notification' | 'read' | 'prefs' | 'connected' }>(
  'rig:notifications-changed'
);

/** Main → renderer: open this space (a banner click or a `rig://space/...` link). */
export const rigOpenSpaceAtChannel = defineEvent<OpenSpaceAt>('rig:open-space-at');

/** Main → renderer: an invite banner was clicked; show the invites list. */
export const rigOpenInvitesChannel = defineEvent<void>('rig:open-invites');
