import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type RefObject } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Popover } from '@renderer/lib/ui/popover';
import type { RigWorkspaceBinding } from '@shared/rig/account';
import { requestOpenSpace } from './open-space-request';
import { PEOPLE_QUERY_KEY, usePeople } from './use-people';

/**
 * Marks a floating layer opened from inside another popover (a person card,
 * a member's role menu), so pressing in it doesn't close the popover it came
 * from. The host popover passes `keepOpenOn={insidePeopleLayer}`.
 */
export const PEOPLE_LAYER_CLASS = 'rig-people-layer';
export const insidePeopleLayer = (target: Element): boolean =>
  target.closest(`.${PEOPLE_LAYER_CLASS}`) !== null;

/** Enough to picture someone before Your people has loaded. `userId` is the relay's tap user id (`usr_…`). */
export type PersonRef = { userId: string; name: string | null; avatarUrl: string | null };

const WORKSPACES_KEY = ['rig', 'account', 'workspaces'] as const;

function spaceLabel(name: string | null, binding: RigWorkspaceBinding | undefined): string {
  const label = binding?.name ?? name ?? 'A space';
  return binding?.kind === 'space' ? `#${label}` : label;
}

/**
 * A person, anywhere (board 26, panel 4): their photo and name, the spaces
 * you share (a click opens one), "Invite to a space" for your spaces
 * they're not in, and "Remove from your people". Exported on its own for
 * surfaces that already have a popover; most callers want
 * `PersonCardPopover`.
 */
export function PersonCard({ person, onClose }: { person: PersonRef; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { supported, people } = usePeople();
  const entry = people.find((p) => p.userId === person.userId) ?? null;
  const name = entry?.name ?? person.name ?? 'Someone';
  const avatarUrl = entry?.avatarUrl ?? person.avatarUrl;

  const workspacesQuery = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: () => rpc.rig.account.workspaces(),
  });
  const workspaces = workspacesQuery.data?.success ? workspacesQuery.data.data : [];
  const byId = new Map(workspaces.map((w) => [w.id, w]));

  const shared = entry?.sharedSpaces ?? [];
  const sharedIds = new Set(shared.map((s) => s.bindingId));
  // Only an owner can invite into a space.
  const invitable = workspaces.filter((w) => w.role === 'owner' && !sharedIds.has(w.id));

  const [mode, setMode] = useState<'idle' | 'picking' | 'confirmRemove'>('idle');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invite = async (binding: RigWorkspaceBinding) => {
    setBusy(true);
    setError(null);
    const result = await rpc.rig.share.inviteToSpace({
      bindingId: binding.id,
      targetUserId: person.userId,
      role: 'editor',
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    setMode('idle');
    setNotice(`Invited ${name} to ${spaceLabel(binding.name, binding)}.`);
    void queryClient.invalidateQueries({ queryKey: PEOPLE_QUERY_KEY });
  };

  const forget = async () => {
    setBusy(true);
    setError(null);
    const result = await rpc.rig.share.forgetPerson({ userId: person.userId });
    setBusy(false);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: PEOPLE_QUERY_KEY });
    onClose();
  };

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="person-card">
      <div className="flex items-center gap-3">
        <IdentityAvatar
          name={name}
          avatarUrl={avatarUrl}
          sizeClassName="size-10"
          textClassName="text-sm"
        />
        <p className="min-w-0 truncate text-sm font-medium text-text-primary">{name}</p>
      </div>

      {shared.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="px-1 text-xs text-text-muted">
            {shared.length === 1 ? '1 space together' : `${shared.length} spaces together`}
          </p>
          {shared.map((space) => (
            <button
              key={space.bindingId}
              type="button"
              onClick={() => {
                const binding = byId.get(space.bindingId);
                requestOpenSpace({
                  bindingId: space.bindingId,
                  spaceName: binding?.name ?? space.name,
                });
                onClose();
              }}
              className="truncate rounded-control px-1 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-bg-2 hover:text-text-primary"
            >
              {spaceLabel(space.name, byId.get(space.bindingId))}
            </button>
          ))}
        </div>
      )}

      {mode === 'picking' && (
        <div className="flex flex-col gap-0.5" data-testid="person-card-spaces">
          <p className="px-1 text-xs text-text-muted">Invite {name} to</p>
          {invitable.length === 0 ? (
            <p className="px-1 text-xs text-text-muted">They're already in every space you own.</p>
          ) : (
            invitable.map((binding) => (
              <button
                key={binding.id}
                type="button"
                disabled={busy}
                onClick={() => void invite(binding)}
                className="truncate rounded-control px-1 py-1 text-left text-xs text-text-primary transition-colors hover:bg-bg-2 disabled:opacity-50"
              >
                {spaceLabel(binding.name, binding)}
              </button>
            ))
          )}
        </div>
      )}

      {mode === 'confirmRemove' && (
        <div className="flex flex-col gap-2 rounded-control bg-bg-2 p-2">
          <p className="text-xs text-text-secondary">
            Take {name} off your people? You keep the spaces you share, and they can still invite
            you.
          </p>
          <div className="flex gap-1.5">
            <Button size="xs" variant="destructive" disabled={busy} onClick={() => void forget()}>
              Remove
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {notice && <p className="text-xs text-text-secondary">{notice}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}

      {mode === 'idle' && (
        <div className="flex flex-wrap gap-1.5">
          {supported === true && (
            <Button size="xs" onClick={() => setMode('picking')}>
              Invite to a space
            </Button>
          )}
          {entry && (
            <Button size="xs" variant="ghost" onClick={() => setMode('confirmRemove')}>
              Remove from your people
            </Button>
          )}
        </div>
      )}

      <p className="border-t border-border-hairline pt-2 text-2xs text-text-muted">
        Name and photo only. People you work with don't see your email.
      </p>
    </div>
  );
}

/**
 * The person card as a popover anchored to whatever was clicked (an avatar,
 * a name). Marked as a people layer, so it can open from inside the share
 * popover. The Room transcript can use this as is.
 */
export function PersonCardPopover({
  person,
  anchor,
  open,
  onClose,
}: {
  person: PersonRef;
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      role="dialog"
      gap={6}
      estimatedWidth={260}
      minWidth={260}
      ariaLabel={person.name ?? 'Person'}
      className={PEOPLE_LAYER_CLASS}
    >
      <PersonCard person={person} onClose={onClose} />
    </Popover>
  );
}
