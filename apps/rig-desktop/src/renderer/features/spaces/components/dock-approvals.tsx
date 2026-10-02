import { useEffect, useRef, type RefObject } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { themeColor, themeOfMessage } from '../dock-model';
import type { Approval } from '../for-you';
import type { RoomThemes } from '../themes';

/**
 * Closes `onClose` on Esc (taking the key, so a focused theme stays) or a
 * press outside `rootRef` (or outside all of them, given several). The root
 * holds the trigger as well as the panel, so the trigger's own click is not
 * an "outside".
 *
 * With `returnFocusTo`, Esc also hands the keyboard back to the trigger, when
 * it was inside the panel (or nowhere): Esc with the cursor in the composer
 * leaves the composer alone.
 */
export function useDismissOutside(
  rootRef: RefObject<HTMLElement | null> | readonly RefObject<HTMLElement | null>[],
  active: boolean,
  onClose: () => void,
  returnFocusTo?: () => HTMLElement | null | undefined
): void {
  const returnRef = useRef(returnFocusTo);
  returnRef.current = returnFocusTo;
  useEffect(() => {
    if (!active) return;
    const roots = Array.isArray(rootRef) ? rootRef : [rootRef];
    const inside = (node: Node | null) => roots.some((root) => !!root.current?.contains(node));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      const at = document.activeElement;
      const keyboardWasHere = !at || at === document.body || inside(at);
      onClose();
      if (keyboardWasHere) returnRef.current?.()?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (roots.some((root) => root.current) && !inside(event.target as Node)) onClose();
    };
    // Capture: the dock's panel answers Esc before the focus handler sees it.
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [rootRef, active, onClose]);
}

function Run({
  approval,
  themes,
  selfUserId,
  onApprove,
  onApproveAll,
  onReject,
}: {
  approval: Approval;
  themes: RoomThemes | null | undefined;
  selfUserId: string;
  onApprove: (runId: string, requestId: string) => void;
  onApproveAll: (runId: string) => void;
  onReject: (runId: string, requestId: string) => void;
}) {
  const theme = themeOfMessage(themes, approval.sessionMessageId);
  const asked = approval.askedBy.id === selfUserId ? 'you asked' : `${approval.askedBy.name} asked`;
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="dock-approval-run"
      data-run-id={approval.runId}
    >
      <div className="flex items-center gap-1.5 text-xs">
        {theme && (
          <>
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: themeColor(theme.id) }}
              aria-hidden
            />
            <span className="min-w-0 truncate font-medium text-text-primary">{theme.name}</span>
          </>
        )}
        <span className="ml-auto shrink-0 text-text-muted">{asked}</span>
      </div>
      {approval.pending.map((request) => (
        <div
          key={request.requestId}
          className="flex items-center gap-2"
          data-testid="dock-approval-request"
        >
          <code
            className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary"
            title={request.title}
          >
            {request.title}
          </code>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onReject(approval.runId, request.requestId)}
          >
            Reject
          </Button>
          <Button size="xs" onClick={() => onApprove(approval.runId, request.requestId)}>
            Approve
          </Button>
        </div>
      ))}
      {approval.pending.length > 1 && (
        <Button
          size="xs"
          variant="secondary"
          className="self-start text-accent"
          onClick={() => onApproveAll(approval.runId)}
        >
          Approve all {approval.pending.length}
        </Button>
      )}
    </div>
  );
}

/**
 * What your agent is waiting on you for, grouped by run: the theme the run
 * is in, who asked, and each request with its Approve and Reject. It sits to
 * the left of the rail, over the transcript, as the stage's float: its shape
 * (rounded, with a neck to the rail) is in the dock's goo layer, so this is
 * only the words and buttons.
 */
export function ApprovalsPanel({
  agentName,
  approvals,
  themes,
  selfUserId,
  onApprove,
  onApproveAll,
  onReject,
}: {
  agentName: string;
  approvals: readonly Approval[];
  themes: RoomThemes | null | undefined;
  selfUserId: string;
  onApprove: (runId: string, requestId: string) => void;
  onApproveAll: (runId: string) => void;
  onReject: (runId: string, requestId: string) => void;
}) {
  const total = approvals.reduce((n, a) => n + a.pending.length, 0);
  // The keyboard moves in when the panel opens, and stays in it when the button
  // that was pressed leaves with its answered request.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);
  const stay =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      fn(...args);
      panelRef.current?.focus({ preventScroll: true });
    };
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`${agentName} approvals`}
      tabIndex={-1}
      data-testid="dock-approvals-panel"
      className="flex flex-col gap-3 p-3 outline-none"
      style={{ width: 340 }}
    >
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-semibold text-text-primary">{agentName}</span>
        {total > 0 && <span className="text-text-muted">{total} waiting</span>}
      </div>
      {approvals.length === 0 ? (
        <p className="text-xs text-text-muted" data-testid="dock-approvals-empty">
          Nothing waiting for your approval.
        </p>
      ) : (
        approvals.map((approval) => (
          <Run
            key={approval.runId}
            approval={approval}
            themes={themes}
            selfUserId={selfUserId}
            onApprove={stay(onApprove)}
            onApproveAll={stay(onApproveAll)}
            onReject={stay(onReject)}
          />
        ))
      )}
    </div>
  );
}
