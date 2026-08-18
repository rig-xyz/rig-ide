import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { RigCommentTarget } from '@shared/rig/comments';
import type {
  RigShareLink,
  RigShareLinkError,
  RigShareLinkMinted,
  SharePermission,
} from '@shared/rig/share-links';
import { resolveCommentTarget } from './comments';
import { readRelayToken } from './config';
import { checkRelayTrust } from './relay-trust';

/**
 * Relay-backed share-link management (`docs/share-links-spec.md` in the tap
 * repo, S1) — mint/list/revoke a public link to one artifact.
 *
 * Own module, own `shareLinks` RPC key (mirrors `account.ts`'s precedent:
 * "its own key rather than folded into `comments`" — see that file's own
 * doc comment) rather than folded into `rigCommentsController`: share links
 * are a genuinely different relay resource (`/share-links`, not
 * `/messages`) with their own error shape (403 `forbidden` for a
 * viewer-only member, 404 `path_not_found` for an untracked file) that
 * doesn't map cleanly onto `RigCommentsError`'s kinds — but they resolve
 * their target exactly the same way comments do, so `resolveCommentTarget`
 * (exported from `comments.ts`) is reused rather than re-derived, same
 * trust-gated PAT path as comments/account (see that file's own header
 * comment on the two credentials in play).
 */

const REQUEST_TIMEOUT_MS = 10_000;

type Resolved = { target: RigCommentTarget; token: string };

const NOT_BOUND: RigShareLinkError = {
  kind: 'notBound',
  message: "This workspace isn't synced to a rig",
};
const UNAUTHENTICATED: RigShareLinkError = {
  kind: 'unauthenticated',
  message: 'Not signed in to Rig Hub — run `rig login`',
};

/** Untrusted relays already warned about, keyed per (binding, host) — not per call. */
const warnedUntrustedRelays = new Set<string>();

function gateRelayTrust(target: RigCommentTarget): RigShareLinkError | null {
  const trust = checkRelayTrust(target.relayUrl);
  if (trust.trusted) return null;
  const key = `${target.bindingId}|${trust.host}`;
  if (!warnedUntrustedRelays.has(key)) {
    warnedUntrustedRelays.add(key);
    log.warn('Rig share links: refusing to send the relay token to an untrusted host', {
      bindingId: target.bindingId,
      host: trust.host,
    });
  }
  return {
    kind: 'untrustedRelay',
    host: trust.host,
    message: `This workspace points share links at an unrecognized relay (${trust.host}) — sharing is disabled.`,
  };
}

async function resolveContext(absPath: string): Promise<Resolved | RigShareLinkError> {
  const target = resolveCommentTarget(absPath);
  if (!target) return NOT_BOUND;
  const untrusted = gateRelayTrust(target);
  if (untrusted) return untrusted;
  const token = await readRelayToken();
  if (!token) return UNAUTHENTICATED;
  return { target, token };
}

function isError(value: Resolved | RigShareLinkError): value is RigShareLinkError {
  return 'kind' in value;
}

function shareLinksUrl({ target }: Resolved, suffix = ''): string {
  const base = target.relayUrl.replace(/\/+$/, '');
  return `${base}/v1/me/bindings/${encodeURIComponent(target.bindingId)}/share-links${suffix}`;
}

/**
 * Turns a non-2xx relay response into a message the UI can show in one
 * line. `forbidden`/`notFound` get their own kinds (see the module doc
 * comment) — everything else falls back to the generic `relay` shape
 * comments/account already use, `status` present so `isOfflineError`-style
 * checks (a thrown transport error has none) still work the same way.
 */
export async function relayError(response: Response, action: string): Promise<RigShareLinkError> {
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
  if (response.status === 403) {
    return {
      kind: 'forbidden',
      message: 'You need editor access on this rig to manage share links.',
    };
  }
  if (response.status === 404) {
    return {
      kind: 'notFound',
      message:
        code === 'path_not_found'
          ? "This file isn't tracked by the rig yet — save and sync it first."
          : `Could not ${action} — not found.`,
    };
  }
  return {
    kind: 'relay',
    status: response.status,
    message: code
      ? `Could not ${action} (relay: ${code}).`
      : `Could not ${action} (relay ${response.status}).`,
  };
}

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

function transportError(action: string, error: unknown): RigShareLinkError {
  log.warn('Rig share links relay request failed', { action, error: String(error) });
  return { kind: 'relay', message: `Could not ${action} — the relay is unreachable.` };
}

// ── payload coercion ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Exported for direct unit testing, same reason `toMessage`/`toUser` are. */
export function toShareLink(value: unknown): RigShareLink | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    bindingId: typeof raw.bindingId === 'string' ? raw.bindingId : '',
    relPath: typeof raw.relPath === 'string' ? raw.relPath : '',
    permission: raw.permission === 'comment' ? 'comment' : 'read',
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    revokedAt: typeof raw.revokedAt === 'string' ? raw.revokedAt : null,
  };
}

// ── controller ───────────────────────────────────────────────────────────────

export const rigShareLinksController = createRPCController({
  /** Mints a new share link for the currently-open file. Editor+ role required. */
  mint: async ({
    absPath,
    permission,
  }: {
    absPath: string;
    permission: SharePermission;
  }): Promise<Result<RigShareLinkMinted, RigShareLinkError>> => {
    const ctx = await resolveContext(absPath);
    if (isError(ctx)) return err(ctx);
    const action = 'create the share link';

    let response: Response;
    try {
      response = await relayFetch(ctx, shareLinksUrl(ctx), {
        method: 'POST',
        body: { relPath: ctx.target.relPath, permission },
      });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));

    try {
      const data = asRecord(await response.json());
      const shareLink = toShareLink(data?.shareLink);
      const url = typeof data?.url === 'string' ? data.url : null;
      if (!shareLink || !url) {
        return err<RigShareLinkError>({ kind: 'relay', message: `Could not ${action}.` });
      }
      return ok({ shareLink, url });
    } catch (error) {
      return err(transportError(action, error));
    }
  },

  /** This file's share links (active and revoked), newest first. */
  list: async ({ absPath }: { absPath: string }): Promise<Result<RigShareLink[], RigShareLinkError>> => {
    const ctx = await resolveContext(absPath);
    if (isError(ctx)) return err(ctx);
    const action = 'load share links';
    const query = new URLSearchParams({ relPath: ctx.target.relPath });

    let response: Response;
    try {
      response = await relayFetch(ctx, shareLinksUrl(ctx, `?${query}`), { method: 'GET' });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));

    try {
      const data = asRecord(await response.json());
      const raw = Array.isArray(data?.shareLinks) ? data.shareLinks : [];
      return ok(raw.map(toShareLink).filter((l): l is RigShareLink => l !== null));
    } catch (error) {
      return err(transportError(action, error));
    }
  },

  /** Revokes one of this file's share links. */
  revoke: async ({
    absPath,
    id,
  }: {
    absPath: string;
    id: string;
  }): Promise<Result<{ revoked: boolean }, RigShareLinkError>> => {
    const ctx = await resolveContext(absPath);
    if (isError(ctx)) return err(ctx);
    const action = 'revoke the share link';

    let response: Response;
    try {
      response = await relayFetch(ctx, shareLinksUrl(ctx, `/${encodeURIComponent(id)}/revoke`), {
        method: 'POST',
      });
    } catch (error) {
      return err(transportError(action, error));
    }
    if (!response.ok) return err(await relayError(response, action));

    try {
      const data = asRecord(await response.json());
      return ok({ revoked: data?.revoked === true });
    } catch (error) {
      return err(transportError(action, error));
    }
  },
});
