import { statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  RIG_COMMENT_ANCHOR_EXACT_MAX,
  RIG_COMMENT_BODY_MAX,
  type RigCommentAnchor,
  type RigCommentAuthorKind,
  type RigCommentList,
  type RigCommentMessage,
  type RigCommentTarget,
  type RigCommentTargetInfo,
  type RigCommentsError,
} from '@shared/rig/comments';
import { findBindingConfig } from './binding';
import { readRelayToken } from './config';
import { checkRelayTrust } from './relay-trust';

/**
 * Relay-backed comments for doc tabs.
 *
 * Two credentials are in play and they are NOT interchangeable:
 *   - the binding file (`.rig/tap-binding.local.json`) supplies `bindingId` and
 *     `relayUrl`. Its `token` is a `tap_cap_` capability token and 401s on the
 *     user-plane comments routes, so it is deliberately unused here.
 *   - `relay_token` in `~/.config/rig/config.json` is the `rpat_` PAT minted by
 *     `rig login` and the only credential these routes accept.
 *
 * The relay has no SSE for comments; the renderer polls.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const LIST_LIMIT = 200;

// ── path mapping ─────────────────────────────────────────────────────────────

function isUnder(root: string, absPath: string): boolean {
  const rel = relative(root, absPath);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith(`${sep}`);
}

/**
 * Nearest ancestor directory holding a `.git` FILE — the root of a linked git
 * worktree. Emdash runs agent sessions in such worktrees: they mirror the repo
 * layout but live outside the rig workspace root, so the manifest-relative path
 * has to be computed against the worktree root instead.
 */
function findWorktreeRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    try {
      if (statSync(join(dir, '.git')).isFile()) return dir;
    } catch {
      // no .git entry here — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Maps an absolute file path to the rig it belongs to plus the manifest-relative
 * path comments are keyed on (e.g. `docs/spec.md`). Returns null when the file
 * isn't inside a rig-bound workspace.
 */
export function resolveCommentTarget(absPath: string): RigCommentTarget | null {
  const fileDir = dirname(resolve(absPath));
  const location = findBindingConfig(fileDir);
  if (!location) return null;

  // Prefer the root that actually contains the file: the binding's workspace
  // root for a plain checkout, the linked-worktree root for a session worktree.
  const root = isUnder(location.workspaceRoot, absPath)
    ? location.workspaceRoot
    : findWorktreeRoot(fileDir);
  if (!root || !isUnder(root, absPath)) return null;

  const relPath = relative(root, resolve(absPath)).split(sep).join('/');
  if (!relPath || relPath.startsWith('..')) return null;

  return {
    bindingId: location.config.bindingId,
    relayUrl: location.config.relayUrl,
    relPath,
  };
}

// ── relay ────────────────────────────────────────────────────────────────────

type Resolved = { target: RigCommentTarget; token: string };

const NOT_BOUND: RigCommentsError = {
  kind: 'notBound',
  message: "This workspace isn't synced to a rig",
};
const UNAUTHENTICATED: RigCommentsError = {
  kind: 'unauthenticated',
  message: 'Not signed in to Rig Hub — run `rig login`',
};

/** Untrusted relays already warned about, keyed per (binding, host) — not per poll. */
const warnedUntrustedRelays = new Set<string>();

/**
 * The trust gate on the user's PAT (see `relay-trust.ts`). Returns null when
 * the target's relay may be sent the token, an error otherwise.
 *
 * Called from `resolveContext` — the only place a `Resolved` (and with it the
 * token) is ever minted — so every `relayFetch` call site is behind it and no
 * future one can forget it. `resolveTarget`'s self-lookup runs the same check.
 */
function gateRelayTrust(target: RigCommentTarget): RigCommentsError | null {
  const trust = checkRelayTrust(target.relayUrl);
  if (trust.trusted) return null;
  const key = `${target.bindingId}|${trust.host}`;
  if (!warnedUntrustedRelays.has(key)) {
    warnedUntrustedRelays.add(key);
    log.warn('Rig comments: refusing to send the relay token to an untrusted host', {
      bindingId: target.bindingId,
      host: trust.host,
    });
  }
  return {
    kind: 'untrustedRelay',
    host: trust.host,
    message: `This workspace points comments at an unrecognized relay (${trust.host}) — comments are disabled.`,
  };
}

async function resolveContext(absPath: string): Promise<Resolved | RigCommentsError> {
  const target = resolveCommentTarget(absPath);
  if (!target) return NOT_BOUND;
  const untrusted = gateRelayTrust(target);
  if (untrusted) return untrusted;
  const token = await readRelayToken();
  if (!token) return UNAUTHENTICATED;
  return { target, token };
}

function isError(value: Resolved | RigCommentsError): value is RigCommentsError {
  return 'kind' in value;
}

function messagesUrl({ target }: Resolved, suffix = ''): string {
  const base = target.relayUrl.replace(/\/+$/, '');
  return `${base}/v1/me/bindings/${encodeURIComponent(target.bindingId)}/messages${suffix}`;
}

/** Turns a non-2xx relay response into a message the UI can show in one line. */
async function relayError(response: Response, action: string): Promise<RigCommentsError> {
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const raw = (body as Record<string, unknown>).error;
      if (typeof raw === 'string') code = raw;
    }
  } catch {
    // non-JSON body; the status alone has to do
  }
  // The relay answers 404 (not 403) for a binding you aren't a member of.
  if (response.status === 404) {
    return { kind: 'relay', status: 404, message: "This rig's comments aren't available to you." };
  }
  return {
    kind: 'relay',
    status: response.status,
    message: code
      ? `Could not ${action} (relay: ${code}).`
      : `Could not ${action} (relay ${response.status}).`,
  };
}

/**
 * The one place the PAT is attached. Only callable with a `Resolved`, which
 * only `resolveContext` mints — and that path runs `gateRelayTrust` first, so
 * the token can never travel to a workspace-declared host that isn't trusted.
 */
async function relayFetch(
  ctx: Resolved,
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown }
): Promise<Response> {
  return fetch(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function transportError(action: string, error: unknown): RigCommentsError {
  log.warn('Rig comments relay request failed', { action, error: String(error) });
  return { kind: 'relay', message: `Could not ${action} — the relay is unreachable.` };
}

// ── payload coercion ─────────────────────────────────────────────────────────
//
// The relay is the schema authority; we only narrow enough to keep the renderer
// honest about nullability, and never drop unknown fields.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function toMessage(value: unknown): RigCommentMessage | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.id !== 'string') return null;
  const author = asRecord(raw.author);
  return {
    id: raw.id,
    seq: String(raw.seq ?? ''),
    bindingId: String(raw.bindingId ?? ''),
    author: {
      userId: typeof author?.userId === 'string' ? author.userId : null,
      name: typeof author?.name === 'string' ? author.name : null,
      avatarUrl: typeof author?.avatarUrl === 'string' ? author.avatarUrl : null,
      kind: author?.kind === 'agent' ? 'agent' : 'user',
    },
    kind: typeof raw.kind === 'string' ? raw.kind : 'text',
    body: typeof raw.body === 'string' ? raw.body : '',
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    intentId: typeof raw.intentId === 'string' ? raw.intentId : null,
    path: typeof raw.path === 'string' ? raw.path : null,
    meta: asRecord(raw.meta),
    anchor: toAnchor(raw.anchor),
    resolvedAt: typeof raw.resolvedAt === 'string' ? raw.resolvedAt : null,
    resolvedBy: typeof raw.resolvedBy === 'string' ? raw.resolvedBy : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    editedAt: typeof raw.editedAt === 'string' ? raw.editedAt : null,
    deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : null,
  };
}

function toAnchor(value: unknown): RigCommentAnchor | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.exact !== 'string') return null;
  return {
    exact: raw.exact,
    ...(typeof raw.prefix === 'string' ? { prefix: raw.prefix } : {}),
    ...(typeof raw.suffix === 'string' ? { suffix: raw.suffix } : {}),
    ...(typeof raw.changeId === 'string' ? { changeId: raw.changeId } : {}),
  };
}

/** Strips unknown keys — the relay rejects an anchor carrying any (400 `invalid_anchor`). */
function outboundAnchor(anchor: RigCommentAnchor): RigCommentAnchor {
  return {
    exact: anchor.exact,
    ...(anchor.prefix ? { prefix: anchor.prefix } : {}),
    ...(anchor.suffix ? { suffix: anchor.suffix } : {}),
    ...(anchor.changeId ? { changeId: anchor.changeId } : {}),
  };
}

/**
 * Optional authorship fields for an outbound post. `authorKind: 'agent'` makes
 * the relay record joint authorship — the post still belongs to the signed-in
 * account, with `meta` (conventionally `{ agent, model }`) naming the agent that
 * actually wrote it. Omitted entirely when the human is the author, so the
 * ordinary path sends exactly the body it always sent.
 */
function attribution(
  authorKind: RigCommentAuthorKind | undefined,
  meta: Record<string, unknown> | undefined
): Record<string, unknown> {
  return {
    ...(authorKind ? { authorKind } : {}),
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

function validateBody(body: string): RigCommentsError | null {
  const trimmed = body.trim();
  if (!trimmed) return { kind: 'invalid', message: 'A comment needs some text.' };
  if (trimmed.length > RIG_COMMENT_BODY_MAX) {
    return {
      kind: 'invalid',
      message: `A comment can be at most ${RIG_COMMENT_BODY_MAX} characters.`,
    };
  }
  return null;
}

// ── self identity ────────────────────────────────────────────────────────────

/**
 * Successful lookups only, keyed by relay + token: the id a token maps to
 * never changes, but a transient failure must be retried on the next resolve.
 */
const selfUserIdCache = new Map<string, string>();

/**
 * Who the signed-in user is on this relay, as `GET /v1/me` reports it.
 *
 * Returns the Clerk user id — the same id the relay stamps as `author.userId`
 * on every message this account posts — so the renderer can tell its own
 * agent-authored replies from a collaborator's. Null on any failure: the
 * renderer then treats no agent message as its own, which is the safe default.
 */
async function readSelfUserId(target: RigCommentTarget): Promise<string | null> {
  if (gateRelayTrust(target) !== null) return null;
  const token = await readRelayToken();
  if (!token) return null;

  const key = `${target.relayUrl}|${token}`;
  const cached = selfUserIdCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const base = target.relayUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = asRecord(await response.json());
    const user = asRecord(data?.user);
    const clerkUserId = user?.clerkUserId;
    if (typeof clerkUserId !== 'string' || clerkUserId.length === 0) return null;
    selfUserIdCache.set(key, clerkUserId);
    return clerkUserId;
  } catch (error) {
    log.warn('Rig comments: could not read the signed-in relay user', { error: String(error) });
    return null;
  }
}

// ── controller ───────────────────────────────────────────────────────────────

/**
 * Every method returns a Result and never throws across the IPC boundary, so
 * the renderer can always render *something*.
 */
export const rigCommentsController = createRPCController({
  /** Which rig (if any) this file's comments belong to, and who the caller is on it. */
  resolveTarget: async ({ absPath }: { absPath: string }) => {
    try {
      const target = resolveCommentTarget(absPath);
      if (!target) return err(NOT_BOUND);
      const info: RigCommentTargetInfo = { target, selfUserId: await readSelfUserId(target) };
      return ok(info);
    } catch (error) {
      log.warn('Rig comments: failed to resolve target', { absPath, error: String(error) });
      return err<RigCommentsError>({ kind: 'notBound', message: NOT_BOUND.message });
    }
  },

  /**
   * Thread roots anchored to this file, plus their replies (replies come back
   * with `path: null`, linked by `parentId`).
   */
  list: async ({ absPath }: { absPath: string }) => {
    const ctx = await resolveContext(absPath);
    if (isError(ctx)) return err(ctx);
    const query = new URLSearchParams({
      path: ctx.target.relPath,
      limit: String(LIST_LIMIT),
    });

    let response: Response;
    try {
      response = await relayFetch(ctx, messagesUrl(ctx, `?${query}`), { method: 'GET' });
    } catch (error) {
      return err(transportError('load comments', error));
    }
    if (!response.ok) return err(await relayError(response, 'load comments'));

    try {
      const data = asRecord(await response.json());
      const raw = Array.isArray(data?.messages) ? data.messages : [];
      const list: RigCommentList = {
        messages: raw.map(toMessage).filter((m): m is RigCommentMessage => m !== null),
        nextCursor: typeof data?.nextCursor === 'string' ? data.nextCursor : null,
      };
      return ok(list);
    } catch (error) {
      return err(transportError('load comments', error));
    }
  },

  /** New anchored thread root. */
  create: async ({
    absPath,
    body,
    anchor,
    authorKind,
    meta,
  }: {
    absPath: string;
    body: string;
    anchor: RigCommentAnchor;
    authorKind?: RigCommentAuthorKind;
    meta?: Record<string, unknown>;
  }) => {
    const invalid = validateBody(body);
    if (invalid) return err(invalid);
    if (!anchor?.exact || anchor.exact.length > RIG_COMMENT_ANCHOR_EXACT_MAX) {
      return err<RigCommentsError>({
        kind: 'invalid',
        message: 'The quoted passage is empty or too long to anchor a comment to.',
      });
    }
    const ctx = await resolveContext(absPath);
    if (isError(ctx)) return err(ctx);

    return postMessage(ctx, 'post the comment', {
      body: body.trim(),
      path: ctx.target.relPath,
      anchor: outboundAnchor(anchor),
      ...attribution(authorKind, meta),
    });
  },

  /** Reply to an existing root. Replies carry no path and no anchor. */
  reply: async ({
    absPath,
    parentId,
    body,
    authorKind,
    meta,
  }: {
    absPath: string;
    parentId: string;
    body: string;
    authorKind?: RigCommentAuthorKind;
    meta?: Record<string, unknown>;
  }) => {
    const invalid = validateBody(body);
    if (invalid) return err(invalid);
    const ctx = await resolveContext(absPath);
    if (isError(ctx)) return err(ctx);

    return postMessage(ctx, 'post the reply', {
      body: body.trim(),
      parentId,
      ...attribution(authorKind, meta),
    });
  },

  /** Resolve or reopen a thread root (the relay rejects this on replies). */
  setResolved: async ({
    absPath,
    messageId,
    resolved,
  }: {
    absPath: string;
    messageId: string;
    resolved: boolean;
  }) => {
    const ctx = await resolveContext(absPath);
    if (isError(ctx)) return err(ctx);
    const action = resolved ? 'resolve the thread' : 'reopen the thread';
    const url = messagesUrl(ctx, `/${encodeURIComponent(messageId)}/resolve`);

    let response: Response;
    try {
      response = await relayFetch(ctx, url, { method: 'POST', body: { resolved } });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));
    return readMessage(response, action);
  },
});

type MessageResult = Result<RigCommentMessage, RigCommentsError>;

async function postMessage(
  ctx: Resolved,
  action: string,
  body: Record<string, unknown>
): Promise<MessageResult> {
  let response: Response;
  try {
    response = await relayFetch(ctx, messagesUrl(ctx), { method: 'POST', body });
  } catch (error) {
    return err(transportError(action, error));
  }
  if (!response.ok) return err(await relayError(response, action));
  return readMessage(response, action);
}

async function readMessage(response: Response, action: string): Promise<MessageResult> {
  try {
    const data = asRecord(await response.json());
    const message = toMessage(data?.message);
    if (!message) return err<RigCommentsError>({ kind: 'relay', message: `Could not ${action}.` });
    return ok(message);
  } catch (error) {
    return err(transportError(action, error));
  }
}
