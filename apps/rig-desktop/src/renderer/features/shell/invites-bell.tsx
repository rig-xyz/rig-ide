import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, FolderDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { relativeTime } from '@renderer/features/chat/session-history';
import { defaultJoinDir } from '@renderer/features/home/join-flow';
import { useAnchorRect } from '@renderer/lib/hooks/use-anchor-rect';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type { RigMyInvite } from '@shared/rig/rig-share';
import { deriveBellState, shapeMyInvites, type MyInviteRow } from './invites-inbox';

/**
 * The topbar invites bell — invites addressed to ME (`rig.share.listMyInvites`,
 * the relay's invitee plane, shipped 2026-08). Renders nothing signed out;
 * signed in, a bell with an accent count dot only when invites exist (the
 * accent budget's live-indicator carve-out — never a badge-zero).
 *
 * Polling is polite: refetch on window focus plus a slow 5-minute interval —
 * an invite arriving within minutes is fine for a bell, and the relay isn't
 * hammered from every open desktop.
 *
 * Accept is SERVER-SIDE membership only, by design: the invitee plane never
 * exposes the invite secret. Round: rig attach — a joined row no longer just
 * points at Home; it offers "Set up locally" right there, driving the same
 * `rpc.rig.join.attach` flow Home's "Download" uses (member-gated, no
 * invite secret needed), opening the result the normal way on success.
 */

const MY_INVITES_KEY = ['rig', 'share', 'myInvites'] as const;
const POLL_INTERVAL_MS = 5 * 60_000;

export function InvitesBell({ onOpenPath }: { onOpenPath: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const rect = useAnchorRect(open, triggerRef, { gap: 6, estimatedHeight: 280, estimatedWidth: 320, align: 'right' });

  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = authQuery.data?.signedIn ?? false;

  const invitesQuery = useQuery({
    queryKey: MY_INVITES_KEY,
    queryFn: () => rpc.rig.share.listMyInvites(),
    enabled: signedIn,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const invites = invitesQuery.data?.success ? invitesQuery.data.data.invites : null;

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

  const bell = deriveBellState(signedIn, invites ? invites.length : null);
  if (!bell.visible) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={bell.count > 0 ? `Invites (${bell.count})` : 'Invites'}
              aria-haspopup="true"
              aria-expanded={open}
              className="text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control relative flex size-7 items-center justify-center transition-colors"
            >
              <Bell size={15} strokeWidth={1.5} />
              {bell.count > 0 && (
                <span className="bg-accent text-accent-ink absolute top-0.5 right-0.5 flex min-w-3.5 items-center justify-center rounded-full px-0.5 text-[8px] leading-3.5 font-medium">
                  {bell.count}
                </span>
              )}
            </button>
          }
        />
        <TooltipContent side="bottom">Invites</TooltipContent>
      </Tooltip>

      {open &&
        rect &&
        createPortal(
          <div
            ref={popupRef}
            style={{
              position: 'fixed',
              width: 320,
              maxHeight: rect.maxHeight,
              overflowY: 'auto',
              ...(rect.placement === 'below' ? { top: rect.top } : { bottom: rect.bottom }),
              ...(rect.align === 'left' ? { left: rect.left } : { right: rect.right }),
            }}
            className="border-border-hairline bg-bg-1 rounded-card shadow-soft z-50 overflow-hidden border"
          >
            <InvitesPopoverContent
              invites={invites}
              // B1 fix: `!invitesQuery.data?.success` was `true` while
              // STILL LOADING too (data undefined before the first fetch
              // resolves), so the popover showed "Could not load your
              // invites" instead of "Loading…" every time it was opened.
              // `data?.success === false` only trips once a fetch has
              // actually resolved unsuccessfully; `isError` covers a
              // transport-level failure (the query function itself threw).
              error={invitesQuery.isError || invitesQuery.data?.success === false}
              onOpenPath={onOpenPath}
            />
          </div>,
          document.body
        )}
    </>
  );
}

function InvitesPopoverContent({
  invites,
  error,
  onOpenPath,
}: {
  invites: RigMyInvite[] | null;
  error: boolean;
  onOpenPath: (path: string) => void;
}) {
  if (invites === null) {
    return (
      <p className="text-text-muted p-3 text-xs">
        {error ? 'Could not load your invites.' : 'Loading…'}
      </p>
    );
  }
  const rows = shapeMyInvites(invites);
  if (rows.length === 0) {
    return <p className="text-text-muted p-3 text-xs">No pending invites.</p>;
  }
  return (
    <div className="flex flex-col gap-1 p-2">
      {rows.map((row) => (
        <InviteRow key={row.id} row={row} onOpenPath={onOpenPath} />
      ))}
    </div>
  );
}

function InviteRow({ row, onOpenPath }: { row: MyInviteRow; onOpenPath: (path: string) => void }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'accepting' | 'declining' | 'joined'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const accept = async () => {
    setPhase('accepting');
    setError(null);
    const result = await rpc.rig.share.acceptMyInvite({ id: row.id });
    if (!result.success) {
      setPhase('idle');
      setError(result.error.message);
      return;
    }
    setPhase('joined');
    // Membership changed server-side: the rig now belongs in Home's shared
    // list, and this invite will drop from the next list read. The joined
    // row stays visible until then so the outcome is legible.
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
    void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY });
  };

  const decline = async () => {
    setPhase('declining');
    setError(null);
    const result = await rpc.rig.share.declineMyInvite({ id: row.id });
    if (!result.success) {
      setPhase('idle');
      setError(result.error.message);
      return;
    }
    // No ceremony: the per-user hide is done; the row disappears with the list.
    void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY });
  };

  const setUpLocally = async () => {
    setSettingUp(true);
    setSetupError(null);
    try {
      const picked = await rpc.app.openSelectDirectoryDialog({
        title: 'Choose a folder',
        message: `Where should "${row.rigName}" be set up?`,
        // A starting suggestion only, seen nowhere but inside the dialog
        // the user controls — never displayed as page text (same
        // convention as Home's "Download").
        defaultPath: defaultJoinDir(row.rigName),
      });
      if (!picked) return;
      const result = await rpc.rig.join.attach({ bindingId: row.bindingId, targetDir: picked });
      if (!result.success) {
        setSetupError(result.error.message);
        return;
      }
      onOpenPath(result.data.localPath);
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Couldn't open the folder picker.");
    } finally {
      setSettingUp(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-1.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-text-primary min-w-0 flex-1 truncate text-xs font-medium">
          {row.rigName}
        </span>
        <span className="bg-bg-2 text-text-secondary rounded-chip shrink-0 px-1.5 py-0.5 font-mono text-xs">
          {row.roleLabel}
        </span>
      </div>
      <div className="text-text-muted flex items-center gap-1.5 text-xs">
        <span className="min-w-0 truncate">{row.inviterLabel}</span>
        <span className="shrink-0 font-mono text-xs">
          {relativeTime(Date.parse(row.createdAt), Date.now())}
        </span>
      </div>
      {error && <p className="text-danger text-xs">{error}</p>}
      {phase === 'joined' ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void setUpLocally()}
            disabled={settingUp}
            className="text-accent flex shrink-0 items-center gap-1 self-start text-xs transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            <FolderDown className="size-3" strokeWidth={1.5} />
            {settingUp ? 'Setting up…' : 'Set up locally'}
          </button>
          {setupError && <p className="text-danger text-xs">{setupError}</p>}
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            onClick={() => void accept()}
            disabled={phase !== 'idle'}
            className="shrink-0"
          >
            {phase === 'accepting' ? 'Accepting…' : 'Accept'}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void decline()}
            disabled={phase !== 'idle'}
            className="shrink-0"
          >
            {phase === 'declining' ? 'Declining…' : 'Decline'}
          </Button>
        </div>
      )}
    </div>
  );
}
