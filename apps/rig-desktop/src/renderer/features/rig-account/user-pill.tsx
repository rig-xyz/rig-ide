import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useRigSignIn } from './use-rig-sign-in';

/**
 * Topbar identity pill — ported from emdash's `RigIdentityChip`
 * (`apps/emdash-desktop/src/renderer/features/sidebar/rig-identity-chip.tsx`):
 * signed out, a compact "Sign in to Rig" affordance running `useRigSignIn`;
 * signed in, an avatar + name that opens a small popover ("Signed in as …" +
 * Sign out) instead of navigating to a Settings page this app doesn't have.
 *
 * The popover's dismiss/positioning is the same portal pattern the harness
 * picker uses (`lib/hooks/use-anchor-rect.ts`), but right-aligned (`right`
 * instead of `left`) since this trigger sits at the window's own right edge.
 * Unlike the picker, focus does move into the popover here — a two-step
 * sign-out confirmation needs real Tab/Enter semantics, not the
 * never-blur-the-trigger trick a flat option list can get away with — so
 * dismissal is a document-level outside-pointerdown/Escape listener that
 * checks both the trigger and the portaled popup.
 *
 * Polish round: `compact` shrinks the trigger to avatar-only (icon-only —
 * Rule 7's compact-chrome carve-out, for the minimalized title bar) while
 * keeping the exact same popover; a tooltip on the trigger keeps it legible
 * without the name label. The popover content itself never changes shape.
 */
export function UserPill({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const rect = useAnchorRect(open, triggerRef, { gap: 6, estimatedHeight: 160, estimatedWidth: 240, align: 'right' });

  const { data: status } = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = status?.signedIn ?? false;

  const meQuery = useQuery({
    queryKey: ['rig', 'account', 'me'],
    queryFn: () => rpc.rig.account.me(),
    enabled: signedIn,
  });

  const { phase, signIn } = useRigSignIn();

  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      setOpen(false);
      setConfirmingSignOut(false);
    };
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

  if (!signedIn) {
    const label = phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…';
    const trigger = (
      <button
        type="button"
        onClick={() => void signIn()}
        disabled={phase !== 'idle'}
        aria-label={compact ? label : undefined}
        className={
          compact
            ? 'text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex size-7 items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-60 [-webkit-app-region:no-drag]'
            : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex h-7 items-center gap-1.5 px-2 text-xs transition-colors disabled:pointer-events-none disabled:opacity-60 [-webkit-app-region:no-drag]'
        }
      >
        <LogIn className="size-3.5 shrink-0" strokeWidth={1.5} />
        {!compact && label}
      </button>
    );
    if (!compact) return trigger;
    return (
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    );
  }

  const user = meQuery.data?.success ? meQuery.data.data : null;
  // `||`, not `??`: name/email can be an empty string as well as null, and an
  // empty label must not survive to render as a blank pill.
  const label = user?.name || user?.email || null;
  const showEmailRow = Boolean(user?.email) && user?.email !== label;

  const doSignOut = async () => {
    const result = await rpc.rig.auth.logout();
    if (!result.success) {
      toast({ title: 'Could not sign out', description: result.error.message, variant: 'destructive' });
      return;
    }
    setOpen(false);
    setConfirmingSignOut(false);
    void queryClient.invalidateQueries({ queryKey: ['rig', 'auth', 'status'] });
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
  };

  const triggerButton = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-haspopup="true"
      aria-expanded={open}
      aria-label={compact ? (label ?? 'Account') : undefined}
      className={
        compact
          ? 'hover:bg-bg-2 rounded-control flex size-7 items-center justify-center transition-colors [-webkit-app-region:no-drag]'
          : 'hover:bg-bg-2 rounded-control flex h-7 items-center gap-1.5 px-1.5 transition-colors [-webkit-app-region:no-drag]'
      }
    >
      <IdentityAvatar
        name={label}
        avatarUrl={user?.avatarUrl ?? null}
        sizeClassName={compact ? 'size-6' : 'size-5'}
        textClassName="text-[9px]"
      />
      {!compact && <span className="text-text-secondary max-w-28 truncate text-xs">{label ?? 'Signed in to Rig'}</span>}
    </button>
  );

  return (
    <>
      {compact ? (
        <Tooltip>
          <TooltipTrigger render={triggerButton} />
          <TooltipContent side="bottom">{label ?? 'Signed in to Rig'}</TooltipContent>
        </Tooltip>
      ) : (
        triggerButton
      )}

      {open &&
        rect &&
        createPortal(
          <div
            ref={popupRef}
            style={{
              position: 'fixed',
              width: 240,
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
              ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
            }}
            className="border-border-hairline bg-bg-1 rounded-card shadow-soft z-50 overflow-hidden border"
          >
            {confirmingSignOut ? (
              <div className="flex flex-col gap-2.5 p-3">
                <p className="text-text-primary text-xs font-medium">Sign out of Rig?</p>
                <p className="text-text-muted text-xs">
                  This signs you out of the rig CLI everywhere on this machine — every terminal, not
                  just here. Comments and sign-in-gated features go dark until you sign back in.
                </p>
                <div className="mt-1 flex justify-end gap-1.5">
                  <Button variant="ghost" size="xs" onClick={() => setConfirmingSignOut(false)}>
                    Cancel
                  </Button>
                  <Button variant="destructive" size="xs" onClick={() => void doSignOut()}>
                    Sign out
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2.5 px-3 py-2.5">
                  <IdentityAvatar
                    name={label}
                    avatarUrl={user?.avatarUrl ?? null}
                    sizeClassName="size-8"
                    textClassName="text-xs"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-text-primary truncate text-xs font-medium">
                      Signed in as {label ?? 'you'}
                    </p>
                    {showEmailRow && <p className="text-text-muted truncate text-xs">{user?.email}</p>}
                  </div>
                </div>
                <div className="border-border-hairline border-t px-3 py-2">
                  <Button variant="outline" size="xs" onClick={() => setConfirmingSignOut(true)}>
                    Sign out
                  </Button>
                </div>
              </>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
