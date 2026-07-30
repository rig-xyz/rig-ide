/**
 * Comments-layer contract, shared by the main-process relay client
 * (`main/rig/comments.ts`) and the renderer's doc comments surface.
 *
 * Mirrors the tap relay's `binding_messages` shape. The renderer never talks to
 * the relay itself: the relay sends no CORS headers for the app:// origin, and
 * the user's relay token must stay in the main process.
 */

import { defineEvent } from '../lib/ipc/events';

export type RigCommentAuthorKind = 'user' | 'agent';

export type RigCommentAuthor = {
  userId: string | null;
  name: string | null;
  avatarUrl: string | null;
  kind: RigCommentAuthorKind;
};

/**
 * Client-supplied text anchor. The relay validates the shape only (and rejects
 * unknown keys), so the exact/prefix/suffix convention must match the rig CLI
 * and the web hub — see `renderer/features/docs/comments/anchors.ts`.
 */
export type RigCommentAnchor = {
  exact: string;
  prefix?: string;
  suffix?: string;
  changeId?: string;
};

export type RigCommentMessage = {
  id: string;
  seq: string;
  bindingId: string;
  author: RigCommentAuthor;
  kind: string;
  body: string;
  parentId: string | null;
  intentId: string | null;
  /** Set on thread roots; replies carry null and are linked by `parentId`. */
  path: string | null;
  meta: Record<string, unknown> | null;
  anchor: RigCommentAnchor | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

/** Where a local file's comments live: which rig, and under which manifest path. */
export type RigCommentTarget = {
  bindingId: string;
  relayUrl: string;
  /** Path relative to the rig content root, forward slashes, no leading `./`. */
  relPath: string;
};

/**
 * `resolveTarget`'s answer: the target, plus who the signed-in user is on that
 * relay. `selfUserId` matches `RigCommentAuthor.userId` on messages this
 * account posts; null when it could not be established (not signed in, relay
 * unreachable, relay untrusted). The renderer uses it to decide whether an
 * agent-authored message was posted by *this* account — relay content is
 * collaborator-writable, so `authorKind: 'agent'` alone proves nothing.
 */
export type RigCommentTargetInfo = {
  target: RigCommentTarget;
  selfUserId: string | null;
};

/**
 * Structured failure. `notBound`, `unauthenticated` and `untrustedRelay` are
 * the ones the UI explains rather than reports — everything else is a one-line
 * message. `agent` covers the mention path only: the comment itself was posted,
 * but the agent turn behind it never produced a reply. `untrustedRelay` means
 * the workspace's binding points comments at a relay host the app refuses to
 * send the user's PAT to — no request was made.
 */
export type RigCommentsError = {
  kind: 'notBound' | 'unauthenticated' | 'untrustedRelay' | 'relay' | 'invalid' | 'agent';
  message: string;
  /** HTTP status, when the relay answered. */
  status?: number;
  /** The offending relay host, for `untrustedRelay`. */
  host?: string;
};

export type RigCommentList = {
  messages: RigCommentMessage[];
  nextCursor: string | null;
};

/** One message of the thread as the agent will read it. */
export type RigCommentThreadEntry = {
  /** Display name of whoever wrote it, or `an agent` for an earlier agent reply. */
  author: string;
  body: string;
};

/**
 * Everything `rig.comments.askAgent` needs to run one headless turn and post its
 * answer back into the thread. The renderer supplies the material; the main
 * process composes the prompt, so the wording lives in exactly one place.
 */
export type RigCommentAgentRequest = {
  absPath: string;
  projectId: string;
  taskId: string;
  /** Thread root the answer is posted under. */
  parentId: string;
  /** Agent provider to run headlessly, e.g. `claude`. */
  providerId: string;
  /** Model override, when the caller has one. */
  model?: string | null;
  /** The passage the thread is anchored to, when it still has one. */
  quote?: string | null;
  /** The thread so far, oldest first, ending with the comment that mentioned the agent. */
  thread: RigCommentThreadEntry[];
};

/** One way to settle a permission request, exactly as the agent offered it. */
export type RigCommentPermissionOption = {
  optionId: string;
  /** Human-readable label, e.g. `Yes` / `Yes, and don't ask again` / `No`. */
  name: string;
  /** ACP kind hint: `allow_once`, `allow_always`, `reject_once`, `reject_always`, … */
  kind: string;
};

/**
 * What is actually being approved, beyond the tool call's display title.
 *
 * The decision-relevant line — the command an execute would run, the path an
 * edit would touch — travels here so the approval card can show it verbatim.
 * Deliberately compact: a line-count summary rather than a diff, so the
 * payload stays small over the events channel.
 */
export type RigCommentPermissionDetail = {
  kind: 'execute' | 'edit' | 'other';
  /** The exact command line, for `execute`. */
  command?: string;
  /** The file the call touches, when it names one. */
  path?: string;
  /** Compact edit summary, e.g. `+12 −3` (line counts) or `delete file`. */
  summary?: string;
};

/** A tool call the headless thread agent is waiting for a human to approve. */
export type RigCommentPermissionRequest = {
  requestId: string;
  /** Display title of the tool call that asked, e.g. `Edit docs/spec.md`. */
  title: string;
  /** Structured detail of the call, when the typed tool call carries any. */
  detail?: RigCommentPermissionDetail;
  options: RigCommentPermissionOption[];
};

/**
 * Everything the thread agent is currently blocked on, for one thread.
 *
 * Main follows the headless session's own state and republishes it here on every
 * change (including back to empty), so the card renders whatever it was last
 * told and never has to reason about session lifetime. The thread root id keys
 * it: the renderer holds no conversation id, and settles through main.
 */
export type RigCommentPermissionUpdate = {
  absPath: string;
  rootId: string;
  requests: RigCommentPermissionRequest[];
};

export const rigCommentPermissionsChannel =
  defineEvent<RigCommentPermissionUpdate>('rig:comment-permissions');

/** Max body length the relay accepts (400 `body_too_long` beyond it). */
export const RIG_COMMENT_BODY_MAX = 8000;

/** Max anchor `exact` length the relay accepts. */
export const RIG_COMMENT_ANCHOR_EXACT_MAX = 2000;
