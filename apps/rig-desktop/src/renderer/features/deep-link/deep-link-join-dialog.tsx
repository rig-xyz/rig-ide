import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { MY_INVITES_KEY_PREFIX } from '@renderer/features/shell/invites-inbox';
import { events, rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { rigDeepLinkJoinChannel, type RigDeepLinkJoin } from '@shared/rig/deep-link';
import type { RigInvitePreview } from '@shared/rig/rig-share';

/**
 * The confirm for a `rig://join/<secret>` link (the website invite page's
 * "Open in Rig"). Any web page can open a `rig://` URL, so a link never
 * joins anything on its own: this names the space (and who shared it) from
 * the invite's public preview and waits for Join / Not now.
 *
 * Join runs the same accept → `join.attach` → open path as Home's pasted
 * link and emailed-invite accept (`new-space-cta.tsx`, `home.tsx`'s
 * `PendingInviteInline`). Without a usable sign-in it offers the app's own
 * sign-in (`useRigSignIn`) and, once that finishes, carries on joining.
 *
 * Links reach it from main (`main/app/deep-links.ts`): one that arrived
 * before this mounted is pulled once via `rpc.rig.deepLink.consumePending`,
 * later ones come live on `rigDeepLinkJoinChannel`. The link carries the
 * invite secret, so it's never shown or echoed into an error line.
 */
export function DeepLinkJoinDialog({ onOpenPath }: { onOpenPath: (path: string) => void }) {
  const [request, setRequest] = useState<RigDeepLinkJoin | null>(null);
  // While a join is in flight, the dialog can't be dismissed and a newer
  // link doesn't replace it mid-way.
  const busyRef = useRef(false);
  const [busy, setBusyState] = useState(false);
  const setBusy = useCallback((next: boolean) => {
    busyRef.current = next;
    setBusyState(next);
  }, []);

  useEffect(() => {
    const show = (next: RigDeepLinkJoin) => {
      if (!busyRef.current) setRequest(next);
    };
    // Listen first, then drain: main starts live delivery on the drain.
    const off = events.on(rigDeepLinkJoinChannel, show);
    rpc.rig.deepLink
      .consumePending()
      .then((pending) => {
        if (pending) show(pending);
      })
      .catch(() => {});
    return () => {
      off();
      void rpc.rig.deepLink.release().catch(() => {});
    };
  }, []);

  const close = useCallback(() => {
    setBusy(false);
    setRequest(null);
  }, [setBusy]);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent>
        {request && (
          // Keyed so a newer link starts from a fresh preview, never a stale error.
          <JoinConfirm
            key={request.link}
            link={request.link}
            onBusyChange={setBusy}
            onClose={close}
            onOpenPath={onOpenPath}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'joining' }
  | { kind: 'signIn' }
  /** Final for this link: only dismissable, or (`wrongAccount`) tried again from another account. */
  | { kind: 'error'; message: string; wrongAccount?: boolean };

function JoinConfirm({
  link,
  onBusyChange,
  onClose,
  onOpenPath,
}: {
  link: string;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onOpenPath: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<RigInvitePreview | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    rpc.rig.share
      .previewInviteLink({ link })
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setPhase({ kind: 'error', message: result.error.message });
          return;
        }
        setPreview(result.data);
        setPhase({ kind: 'ready' });
      })
      .catch(() => {
        if (!cancelled)
          setPhase({ kind: 'error', message: "Couldn't load this invite. Try the link again." });
      });
    return () => {
      cancelled = true;
    };
  }, [link]);

  const spaceName = preview?.spaceName ?? null;
  const spaceLabel = spaceName ? `#${spaceName}` : 'this space';

  const join = useCallback(async () => {
    setPhase({ kind: 'joining' });
    onBusyChange(true);
    try {
      const joined = await rpc.rig.share.acceptInviteLink({ link });
      if (!joined.success) {
        setPhase(
          joined.error.kind === 'notSignedIn'
            ? { kind: 'signIn' }
            : { kind: 'error', message: joined.error.message, wrongAccount: joined.error.kind === 'wrongAccount' }
        );
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
      void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
      const name = joined.data.spaceName ?? spaceName;
      const attached = await rpc.rig.join.attach({ bindingId: joined.data.bindingId, name });
      if (!attached.success) {
        // Joined server-side either way — the space shows on Home to set up from there.
        setPhase({
          kind: 'error',
          message: `You joined ${name ? `#${name}` : 'the space'}, but it couldn't be set up here: ${attached.error.message}`,
        });
        return;
      }
      markJustAttachedSyncing(attached.data.localPath, attached.data.syncing);
      onOpenPath(attached.data.localPath);
      onClose();
    } catch {
      setPhase({ kind: 'error', message: "Couldn't join this space. Try the link again." });
    } finally {
      onBusyChange(false);
    }
  }, [link, onBusyChange, onClose, onOpenPath, queryClient, spaceName]);

  // Signed in from here: carry straight on with the join the user already
  // asked for — but only while this confirm is still open. A dismissed one
  // cancels its sign-in, and a sign-in that finishes anyway joins nothing.
  const mountedRef = useRef(true);
  const signIn = useRigSignIn(() => {
    if (mountedRef.current) void join();
  });
  const signInPhaseRef = useRef(signIn.phase);
  signInPhaseRef.current = signIn.phase;
  const cancelSignInRef = useRef(signIn.cancel);
  cancelSignInRef.current = signIn.cancel;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (signInPhaseRef.current !== 'idle') cancelSignInRef.current();
    };
  }, []);

  // The invite is for another address: sign this computer out, sign in as
  // the right account, and the join carries on from there.
  const signInAnother = async () => {
    const out = await rpc.rig.auth.logout().catch(() => null);
    if (!out?.success) {
      setPhase({ kind: 'error', message: "Couldn't sign out of this account. Try again from Settings." });
      return;
    }
    setPhase({ kind: 'signIn' });
    void signIn.signIn();
  };

  const title =
    phase.kind === 'error'
      ? "Couldn't join"
      : phase.kind === 'loading'
        ? 'Join a space?'
        : `Join ${spaceLabel}?`;

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="deep-link-join" data-phase={phase.kind}>
      <div className="flex flex-col gap-1">
        <DialogTitle>{title}</DialogTitle>
        {phase.kind !== 'error' && preview?.inviterName && (
          <p className="text-xs text-text-muted">Invited by {preview.inviterName}</p>
        )}
      </div>

      {phase.kind === 'loading' && <p className="text-sm text-text-muted">Checking the invite…</p>}
      {(phase.kind === 'ready' || phase.kind === 'joining') && (
        <p className="text-sm text-text-secondary">
          You opened an invite link. Join only if you expected it.
        </p>
      )}
      {(phase.kind === 'ready' || phase.kind === 'joining') && preview?.emailHint && (
        <p className="text-xs text-text-muted" data-testid="deep-link-invited-email">
          This invite is for {preview.emailHint}.
        </p>
      )}
      {phase.kind === 'signIn' && (
        <p className="text-sm text-text-secondary">
          {signIn.phase === 'waiting'
            ? 'Finish signing in in your browser — joining continues here after.'
            : `Sign in to join ${spaceLabel}.`}
        </p>
      )}
      {phase.kind === 'signIn' && signIn.error && (
        <p className="text-xs text-danger">{signIn.error}</p>
      )}
      {phase.kind === 'error' && <p className="text-sm text-danger">{phase.message}</p>}
      {phase.kind === 'error' && phase.wrongAccount && (
        <p className="text-xs text-text-muted">
          Sign in with the account it was sent to. If that address is yours too, add it to your Rig account, then try again.
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        {phase.kind === 'error' ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
            {phase.wrongAccount && (
              <Button size="sm" onClick={() => void signInAnother()} data-testid="deep-link-sign-in-another">
                Sign in with another account
              </Button>
            )}
          </>
        ) : phase.kind === 'signIn' ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Not now
            </Button>
            <Button
              size="sm"
              onClick={() => void signIn.signIn()}
              disabled={signIn.phase !== 'idle'}
            >
              {signIn.phase === 'idle' ? 'Sign in' : 'Waiting for sign-in…'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={phase.kind === 'joining'}>
              Not now
            </Button>
            <Button size="sm" onClick={() => void join()} disabled={phase.kind !== 'ready'}>
              {phase.kind === 'joining' ? 'Joining…' : 'Join'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
