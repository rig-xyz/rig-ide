/**
 * Comments-layer contract, shared by the main-process relay client
 * (`main/rig/comments.ts`) and the renderer's doc comments surface.
 *
 * Mirrors the tap relay's `binding_messages` shape. The renderer never talks to
 * the relay itself: the relay sends no CORS headers for the app:// origin, and
 * the user's relay token must stay in the main process.
 */

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
 * Structured failure. `notBound` and `unauthenticated` are the two the UI
 * explains rather than reports — everything else is a one-line message.
 */
export type RigCommentsError = {
  kind: 'notBound' | 'unauthenticated' | 'relay' | 'invalid';
  message: string;
  /** HTTP status, when the relay answered. */
  status?: number;
};

export type RigCommentList = {
  messages: RigCommentMessage[];
  nextCursor: string | null;
};

/** Max body length the relay accepts (400 `body_too_long` beyond it). */
export const RIG_COMMENT_BODY_MAX = 8000;

/** Max anchor `exact` length the relay accepts. */
export const RIG_COMMENT_ANCHOR_EXACT_MAX = 2000;
