import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Share2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isOfflineError } from '@renderer/features/docs/comments/comments-cache';
import { relativeTime } from '@renderer/features/chat/session-history';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { useClipboard } from '@renderer/lib/hooks/use-clipboard';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import type { RigShareLink, RigShareLinkError, SharePermission } from '@shared/rig/share-links';
import { deriveMintedDisplay, deriveRevokeTarget, needsRemint, type MintedLink } from './share-mint-state';

/**
 * The desktop end of the live share-link feature — a "Share" button in the
 * artifact view header that opens a popover: choose read/comment, mint a
 * link, copy it, see and revoke this file's existing ones. Portal pattern
 * matches `UserPill`'s (document-level mousedown/Escape dismissal, not the
 * blur-to-dismiss trick `HarnessPicker` uses) — this popover has real
 * interactive surface (a permission choice, a Create button, per-link
 * Revoke buttons) where a stray click shouldn't blur-and-close it.
 */
export function ShareButton({ absPath, className }: { absPath: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const rect = useAnchorRect(open, triggerRef, { gap: 6, estimatedHeight: 280 });

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className={cn(
          'border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex shrink-0 items-center gap-1 border bg-transparent px-2 py-1 text-xs transition-colors',
          className
        )}
      >
        <Share2 className="size-3.5" strokeWidth={1.5} />
        Share
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={popupRef}
            style={{
              position: 'fixed',
              right: rect.right,
              width: 280,
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
            }}
            className="border-border-hairline bg-bg-1 rounded-card shadow-soft z-50 overflow-hidden border"
          >
            <SharePopoverContent absPath={absPath} />
          </div>,
          document.body
        )}
    </>
  );
}

function SharePopoverContent({ absPath }: { absPath: string }) {
  const queryClient = useQueryClient();
  const [permission, setPermission] = useState<SharePermission>('read');
  const [minted, setMinted] = useState<MintedLink | null>(null);
  const [minting, setMinting] = useState(false);
  const [reminting, setReminting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const clipboard = useClipboard();
  // Guards against an out-of-order response: if the user toggles again
  // before an in-flight (re)mint resolves, a later toggle bumps this and
  // the earlier response is dropped on arrival instead of clobbering
  // whatever the user has since selected.
  const mintGenerationRef = useRef(0);
  // A3 fix — kept in sync with `permission` every render so `doMint`'s
  // completion handler (a closure captured when the mint was KICKED OFF)
  // can read the CURRENT selection at resolution time instead of the
  // stale one, without retriggering the effect/render cycle a state read
  // would.
  const permissionRef = useRef(permission);
  permissionRef.current = permission;

  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = authQuery.data?.signedIn ?? false;

  const listKey = ['rig', 'shareLinks', 'list', absPath] as const;
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: () => rpc.rig.shareLinks.list({ absPath }),
    enabled: signedIn,
  });

  const { signIn, phase: signInPhase } = useRigSignIn(() => {
    void queryClient.invalidateQueries({ queryKey: listKey });
  });

  if (authQuery.isLoading) return null;

  if (!signedIn) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-text-muted text-xs">Sign in to Rig to create share links.</p>
        <Button variant="outline" size="xs" onClick={() => void signIn()} disabled={signInPhase !== 'idle'}>
          {signInPhase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
        </Button>
      </div>
    );
  }

  const listError = listQuery.data && !listQuery.data.success ? listQuery.data.error : null;

  if (listError) {
    // Every failure here means the whole surface is unusable, not just the
    // last action (`notBound`/`untrustedRelay`/`forbidden`/`notFound`/a
    // real relay error all say so via `.message`) — shown in place of the
    // picker/links, matching the pattern `comments-store.ts` uses. Offline
    // (`comments-cache.ts`'s `isOfflineError` — a thrown transport error,
    // no `status`) is the one exception: a MODE, not an error, same
    // "offline · …" mono language as elsewhere.
    const offline = isOfflineError(listError);
    return (
      <p className={cn('text-text-muted p-3 text-xs', offline && 'font-mono')}>
        {offline ? 'offline · share links unavailable' : listError.message}
      </p>
    );
  }

  const links = listQuery.data?.success ? listQuery.data.data : [];
  const active = links.filter((l) => !l.revokedAt);

  // The one place a link is actually minted, whether from "Create link"
  // (`staleId: null`) or a permission toggle replacing an already-minted
  // one (`staleId`: the link it's replacing — revoked only after the new
  // one lands, never before, so a failed re-mint never leaves the file
  // with zero working links).
  const doMint = async (perm: SharePermission, staleId: string | null) => {
    const generation = ++mintGenerationRef.current;
    if (staleId) setReminting(true);
    else setMinting(true);
    setMintError(null);

    const result = await rpc.rig.shareLinks.mint({ absPath, permission: perm });
    if (mintGenerationRef.current !== generation) {
      // A3(b) fix — superseded by a later mint (the toggles/Create button
      // are disabled while minting, but a double-click racing ahead of
      // that disabled state committing is still possible). This call's OWN
      // result, if it minted successfully, would otherwise be an orphan —
      // a real capability token nobody will ever display or revoke through
      // the normal flow. Clean it up instead of leaving it dangling.
      if (result.success) {
        void rpc.rig.shareLinks.revoke({ absPath, id: result.data.shareLink.id }).then(() => {
          void queryClient.invalidateQueries({ queryKey: listKey });
        });
      }
      return;
    }
    setReminting(false);
    setMinting(false);
    if (!result.success) {
      setMintError(result.error.message);
      return;
    }

    // A3(a) fix — re-checked against the CURRENT selection (`permissionRef`,
    // not the `perm` this call was kicked off for), since the user may
    // have toggled away and back to the stale link's own permission while
    // this remint was in flight. See `deriveRevokeTarget`'s own doc
    // comment for the full reasoning.
    const freshId = result.data.shareLink.id;
    const revokeTarget = deriveRevokeTarget(staleId, perm, permissionRef.current, freshId);

    if (revokeTarget && revokeTarget.id === freshId) {
      // The current selection has moved on from `perm` — `staleId`'s link
      // is what's actually wanted, and it's still alive (never touched
      // below). This fresh mint is the one that's now stale: revoke it,
      // and never let `minted` point at it in the first place — the
      // ALREADY-displayed link (still `staleId`'s own data) is exactly
      // right and must not be overwritten with a dead one.
      void rpc.rig.shareLinks.revoke({ absPath, id: freshId }).then(() => {
        void queryClient.invalidateQueries({ queryKey: listKey });
      });
      return;
    }

    setMinted({ id: freshId, permission: perm, url: result.data.url });
    void queryClient.invalidateQueries({ queryKey: listKey });
    if (revokeTarget) {
      void rpc.rig.shareLinks.revoke({ absPath, id: revokeTarget.id }).then(() => {
        void queryClient.invalidateQueries({ queryKey: listKey });
      });
    }
  };

  const selectPermission = (next: SharePermission) => {
    setPermission(next);
    if (needsRemint(minted, next)) void doMint(next, minted!.id);
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    const result = await rpc.rig.shareLinks.revoke({ absPath, id });
    setRevokingId(null);
    if (!result.success) {
      setMintError(result.error.message);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: listKey });
  };

  const mintedDisplay = deriveMintedDisplay(minted, permission, reminting);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="grid grid-cols-2 gap-1 rounded-control border-border-hairline border p-1">
        <button
          type="button"
          onClick={() => selectPermission('read')}
          // A3 fix: disabled while a mint is in flight — the first line of
          // defense against toggling mid-remint (see `doMint`'s own
          // `deriveRevokeTarget` re-check for the backstop, since a click
          // can still race ahead of this attribute committing).
          disabled={minting || reminting}
          className={cn(
            'rounded-control px-2 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50',
            permission === 'read'
              ? 'bg-bg-2 text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
          )}
        >
          View
        </button>
        <button
          type="button"
          onClick={() => selectPermission('comment')}
          disabled={minting || reminting}
          className={cn(
            'rounded-control px-2 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50',
            permission === 'comment'
              ? 'bg-bg-2 text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
          )}
        >
          View & comment
        </button>
      </div>
      <p className="text-text-muted text-xs">
        {permission === 'read'
          ? 'Anyone with the link can view.'
          : 'Anyone with the link can view and comment.'}
      </p>

      {mintError && <p className="text-danger text-xs">{mintError}</p>}

      <Button size="sm" onClick={() => void doMint(permission, null)} disabled={minting || reminting}>
        {minting ? 'Creating…' : 'Create link'}
      </Button>

      {mintedDisplay.kind === 'updating' && (
        // Permission is baked into the capability token at mint time — the
        // same URL can't just change meaning, so a toggle away from the
        // minted link's own permission NEVER leaves it on screen (see
        // `deriveMintedDisplay`) — this quiet state fills the gap while the
        // replacement is minted, rather than showing nothing at all.
        <div className="border-border-hairline bg-bg-2 flex items-center gap-2 rounded-control border px-2 py-1.5">
          <span className="text-text-muted text-xs">Updating link…</span>
        </div>
      )}

      {mintedDisplay.kind === 'link' && (
        // The relay hands back the raw URL exactly once, right here — `list`
        // below never carries it again (see `RigShareLinkMinted`'s own doc
        // comment), so this is the one moment there's anything to copy.
        <div className="border-border-hairline bg-bg-2 flex items-center gap-2 rounded-control border px-2 py-1.5">
          <span className="text-text-secondary min-w-0 flex-1 truncate font-mono text-xs">
            {mintedDisplay.link.url}
          </span>
          <button
            type="button"
            onClick={() => clipboard.copy(mintedDisplay.link.url)}
            aria-label={clipboard.copied ? 'Copied' : 'Copy'}
            className="text-text-muted hover:text-text-primary flex shrink-0 items-center gap-1 text-xs transition-colors"
          >
            {clipboard.copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {clipboard.copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      {active.length > 0 && (
        <div className="border-border-hairline flex flex-col gap-1 border-t pt-2">
          <p className="text-text-muted px-0.5 font-mono text-xs tracking-wide uppercase">
            Existing links
          </p>
          {active.map((link) => (
            <ShareLinkRow
              key={link.id}
              link={link}
              busy={revokingId === link.id}
              onRevoke={() => void revoke(link.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ShareLinkRow({
  link,
  busy,
  onRevoke,
}: {
  link: RigShareLink;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-0.5 py-1">
      <span className="bg-bg-2 text-text-secondary rounded-chip shrink-0 px-1.5 py-0.5 font-mono text-xs">
        {link.permission === 'comment' ? 'comment' : 'read'}
      </span>
      <span className="text-text-muted min-w-0 flex-1 truncate font-mono text-xs">
        created {relativeTime(new Date(link.createdAt).getTime(), Date.now())}
      </span>
      <Button variant="ghost" size="xs" onClick={onRevoke} disabled={busy} className="shrink-0">
        <X className="size-3" />
        {busy ? 'Revoking…' : 'Revoke'}
      </Button>
    </div>
  );
}

// Re-exported so callers don't need to reach into `@shared/rig/share-links`
// just to type an error they're only ever going to render as `.message`.
export type { RigShareLinkError };
