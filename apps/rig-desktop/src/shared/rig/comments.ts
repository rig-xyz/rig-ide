/**
 * Comments-layer contract, shared by the main-process relay client
 * (`main/rig/comments.ts`) and the renderer's doc comments surface.
 *
 * Mirrors the tap relay's `binding_messages` shape. The renderer never talks to
 * the relay itself: the relay sends no CORS headers for the app:// origin, and
 * the user's relay token must stay in the main process.
 */

import { defineEvent } from '../lib/ipc/events';

/**
 * `'guest'`: a comment posted via a share link — no binding membership, no
 * Clerk account behind it, just a display name the guest gave. The relay is
 * the schema authority here (`main/rig/comments.ts`'s `toMessage`): this
 * type only names the third case, it never infers it client-side — an
 * older relay that hasn't shipped guest support yet still just says `user`,
 * and that's rendered as a normal member, not guessed at.
 */
export type RigCommentAuthorKind = 'user' | 'agent' | 'guest';

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

/**
 * The last-synced thread snapshot for one (binding, file) — `rig_comments_cache`,
 * graduated from a `docs:comments-cache:*` localStorage blob in
 * `persistence-design.md` Round A. Deliberately the same shape as the
 * renderer's own `CommentsCacheEntry` (`comments-cache.ts`) so
 * `parseCommentsCache` can validate an RPC response exactly the way it
 * already validates a parsed localStorage blob — same seam, different IO.
 */
export type RigCommentsCacheEntry = {
  bindingId: string;
  relPath: string;
  /** ISO-8601 timestamp of the read that produced this snapshot. */
  lastSyncedAt: string;
  messages: RigCommentMessage[];
};

/**
 * A person on the binding — for the `@mention` menu's People section.
 * Mirrors `GET /v1/me/bindings/:bindingId/members`'s `members[]` (tap relay,
 * `routes/account.ts`): `userId`/`role` come straight off `binding_members`,
 * `name`/`avatarUrl` are enriched from the Clerk profile server-side and are
 * nullable whenever that lookup didn't resolve. `email` is included for
 * completeness (the relay always tries to have one) even though the mention
 * menu itself only needs `name`/`avatarUrl`.
 */
export type RigCommentMember = {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  role: string;
};

export type RigCommentMemberList = {
  members: RigCommentMember[];
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
 *
 * No `projectId`/`taskId`: this app has no emdash task behind a bound-rig
 * folder open, so the dispatch's working directory is derived in main from
 * `absPath` itself (`resolveCommentWorkspaceRoot` in `main/rig/comments.ts`)
 * rather than looked up by a task id that doesn't exist here.
 */
export type RigCommentAgentRequest = {
  absPath: string;
  /** Thread root the answer is posted under. */
  parentId: string;
  /** Agent provider to run headlessly, e.g. `claude`. */
  providerId: string;
  /** Model override, when the caller has one. */
  model?: string | null;
  /** The passage the thread is anchored to, when it still has one. */
  quote?: string | null;
  /** Full quote anchor for prompt-scoped provenance retrieval. */
  anchor?: RigCommentAnchor | null;
  /** The thread so far, oldest first, ending with the comment that mentioned the agent. */
  thread: RigCommentThreadEntry[];
  /**
   * This turn is a paintbrush stroke (`renderer/features/docs/paintbrush`):
   * the reviewer selected the anchored passage and armed an agent on it,
   * rather than plainly `@mention`-ing one into an existing conversation.
   * Changes the prompt (`main/rig/comment-agent-prompt.ts`) to ask for a
   * structured replacement instead of a direct tool edit, and the answer is
   * parsed for one (`main/rig/comment-agent-proposal.ts`). Defaults to
   * false/absent for every existing `@mention` call site — those keep
   * today's direct-tool-edit behavior unchanged.
   */
  paintbrush?: boolean;
};

/** A reply's structured proposed replacement for the anchored range — see `main/rig/comment-agent-proposal.ts`. */
export type CommentProposal = { replacement: string };

/**
 * Reads `meta.proposal` off a comment message, when the agent emitted a
 * structured replacement for the thread's anchored range (paintbrush
 * outcome). `meta` is freeform (this module's own note above), so this
 * narrows defensively: a foreign or malformed value degrades to "no
 * proposal" rather than throwing.
 */
export function getCommentProposal(meta: Record<string, unknown> | null): CommentProposal | null {
  const raw = meta?.proposal;
  if (typeof raw !== 'object' || raw === null) return null;
  const replacement = (raw as Record<string, unknown>).replacement;
  return typeof replacement === 'string' && replacement.length > 0 ? { replacement } : null;
}

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
 * edit or read would touch, the URL a fetch would hit — travels here so the
 * approval card can show it verbatim (behind a disclosure — see
 * `comments-margin.tsx`'s `PermissionRequestRow`) and so the human-readable
 * headline (`renderer/features/docs/comments/permission-summary.ts`) has
 * something typed to summarize instead of parsing the raw title. Deliberately
 * compact: a line-count summary rather than a diff, so the payload stays
 * small over the events channel.
 */
export type RigCommentPermissionDetail = {
  kind: 'execute' | 'edit' | 'read' | 'fetch' | 'other';
  /** The exact command line, for `execute`. */
  command?: string;
  /** The file the call touches, for `edit`/`read`. */
  path?: string;
  /** Compact edit summary, e.g. `+12 −3` (line counts) or `delete file`, for `edit`. */
  summary?: string;
  /** The URL the call would fetch, for `fetch`. */
  url?: string;
  /** Tool name/id a provider gave an otherwise-untyped call, for `other`. */
  name?: string;
};

/** A tool call the headless thread agent is waiting for a human to approve. */
export type RigCommentPermissionRequest = {
  requestId: string;
  /** Display title of the tool call that asked, e.g. `Edit docs/spec.md`. */
  title: string;
  /** Structured detail of the call, when the typed tool call carries any. */
  detail?: RigCommentPermissionDetail;
  /** The agent's own stated reason for the call, when the provider gave one (e.g. Claude's `rawInput.description`). */
  reason?: string;
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
  /** The headless turn's working directory, so the card can render an edit/read's path workspace-relative. Null when it couldn't be resolved. */
  workspaceRoot: string | null;
};

export const rigCommentPermissionsChannel =
  defineEvent<RigCommentPermissionUpdate>('rig:comment-permissions');

export type RigCommentAgentActivity =
  | 'working'
  | 'thinking'
  | 'checking-context'
  | 'using-tool'
  | 'writing';

/** Live, reader-safe projection of one headless comment turn. */
export type RigCommentAgentProgressUpdate = {
  absPath: string;
  rootId: string;
  activity: RigCommentAgentActivity;
  /** Assistant prose accumulated so far; never thinking or tool output. */
  text: string;
};

export const rigCommentAgentProgressChannel = defineEvent<RigCommentAgentProgressUpdate>(
  'rig:comment-agent-progress'
);

/** Max body length the relay accepts (400 `body_too_long` beyond it). */
export const RIG_COMMENT_BODY_MAX = 8000;

/** Max anchor `exact` length the relay accepts. */
export const RIG_COMMENT_ANCHOR_EXACT_MAX = 2000;
