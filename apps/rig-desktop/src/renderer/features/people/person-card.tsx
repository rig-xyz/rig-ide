import { useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Search } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Popover, PopoverMenuItem } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import type { RigWorkspaceBinding } from '@shared/rig/account';
import { requestOpenSpace } from './open-space-request';
import { foldName, spacesWithYou, withSpacesOnly } from './people-state';
import { PEOPLE_QUERY_KEY, useMySpaces, usePeople } from './use-people';

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

/** Shared spaces shown before "+N more". */
const SHARED_ROWS = 4;

const bare = (name: string) => name.replace(/^#/, '');

/** "# name": the hash quiet, the name in the row's own color. */
function SpaceName({ name }: { name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-text-muted">#</span>
      <span className="truncate">{bare(name)}</span>
    </span>
  );
}

/**
 * A person, anywhere (board 26, panel 4): their photo and name, how many
 * spaces you share, the first few of those spaces (a click opens one),
 * "Invite to a space" with a searchable picker of your spaces they're not
 * in, and "Hide" behind the ⋯ button, which drops them from suggestions
 * until you share a space again. Spaces only: a rig you share never shows
 * here. Exported on its own for surfaces that already
 * have a popover; most callers want `PersonCardPopover`.
 */
export function PersonCard({ person, onClose }: { person: PersonRef; onClose: () => void }) {
  const queryClient = useQueryClient();
  const moreRef = useRef<HTMLButtonElement>(null);
  const { supported, people } = usePeople();
  const spaces = useMySpaces();
  const entry = people.find((p) => p.userId === person.userId) ?? null;
  const name = entry?.name ?? person.name ?? 'Someone';
  // The face that was clicked first, so the card shows the same one.
  const avatarUrl = person.avatarUrl ?? entry?.avatarUrl ?? null;

  const spaceById = new Map((spaces ?? []).map((space) => [space.id, space]));
  const shared =
    entry && spaces ? (withSpacesOnly([entry], new Set(spaceById.keys()))[0]?.sharedSpaces ?? []) : [];
  const sharedIds = new Set(entry?.sharedSpaces.map((s) => s.bindingId) ?? []);
  // Only an owner can invite into a space.
  const invitable = (spaces ?? []).filter((s) => s.role === 'owner' && !sharedIds.has(s.id));

  const [showAll, setShowAll] = useState(false);
  const [mode, setMode] = useState<'idle' | 'picking'>('idle');
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visibleShared = showAll ? shared : shared.slice(0, SHARED_ROWS);
  const hiddenCount = shared.length - visibleShared.length;
  const q = foldName(search);
  const pickable = q ? invitable.filter((s) => foldName(bare(s.name)).includes(q)) : invitable;

  const invite = async (space: RigWorkspaceBinding) => {
    setBusy(true);
    setError(null);
    const result = await rpc.rig.share.inviteToSpace({
      bindingId: space.id,
      targetUserId: person.userId,
      role: 'editor',
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    setMode('idle');
    setSearch('');
    setNotice(`Invited to #${bare(space.name)}`);
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

  const subtitle = entry?.viaOrg && shared.length === 0 ? 'Your organization' : spacesWithYou(shared.length);

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="person-card">
      <div className="flex items-center gap-3">
        <IdentityAvatar name={name} avatarUrl={avatarUrl} sizeClassName="size-10" textClassName="text-sm" />
        <div className="flex min-w-0 flex-col">
          <p className="truncate text-sm font-medium text-text-primary">{name}</p>
          {subtitle && <p className="truncate text-xs text-text-muted">{subtitle}</p>}
        </div>
      </div>

      {shared.length > 0 && (
        <div className="-mx-2 flex flex-col" data-testid="person-card-shared">
          {visibleShared.map((space) => {
            const spaceName = spaceById.get(space.bindingId)?.name ?? space.name ?? 'A space';
            return (
              <button
                key={space.bindingId}
                type="button"
                onClick={() => {
                  requestOpenSpace({ bindingId: space.bindingId, spaceName });
                  onClose();
                }}
                className="flex h-7 cursor-pointer items-center rounded-control px-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-2 hover:text-text-primary"
              >
                <SpaceName name={spaceName} />
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="flex h-7 items-center rounded-control px-2 text-left text-xs text-text-muted transition-colors hover:bg-bg-2 hover:text-text-primary"
            >
              +{hiddenCount} more
            </button>
          )}
        </div>
      )}

      {mode === 'picking' && (
        <div className="flex flex-col gap-1" data-testid="person-card-spaces">
          <label className="flex h-8 items-center gap-2 rounded-control border border-border-hairline px-2 focus-within:border-border-strong">
            <Search className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && pickable[0] && !busy) void invite(pickable[0]);
              }}
              placeholder="Find a space"
              aria-label="Find a space"
              className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
          {/* The card's one scroll region: about six spaces, then it scrolls. */}
          <div className="-mx-2 flex max-h-[168px] flex-col overflow-y-auto">
            {pickable.map((space) => (
              <button
                key={space.id}
                type="button"
                disabled={busy}
                onClick={() => void invite(space)}
                className="flex h-7 shrink-0 items-center rounded-control px-2 text-left text-xs text-text-primary transition-colors hover:bg-bg-2 disabled:opacity-50"
              >
                <SpaceName name={space.name} />
              </button>
            ))}
            {pickable.length === 0 && (
              <p className="flex h-7 items-center px-2 text-xs text-text-muted">
                {spaces === null
                  ? 'Loading your spaces…'
                  : invitable.length === 0
                    ? 'They’re in every space you own.'
                    : 'No space by that name.'}
              </p>
            )}
          </div>
        </div>
      )}

      {notice && <p className="text-xs text-text-secondary">{notice}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}

      {(supported === true || entry) && (
        <div className="flex items-center justify-between gap-1.5">
          {supported === true && (
            <Button
              size="sm"
              variant={mode === 'picking' ? 'ghost' : 'default'}
              className={cn(mode !== 'picking' && 'flex-1')}
              onClick={() => {
                setNotice(null);
                setMode(mode === 'picking' ? 'idle' : 'picking');
              }}
            >
              {mode === 'picking' ? 'Cancel' : 'Invite to a space'}
            </Button>
          )}
          {entry && (
            <Button
              ref={moreRef}
              size="icon-sm"
              variant="ghost"
              className={cn('size-7', menuOpen && 'bg-bg-2')}
              aria-label={`More for ${name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MoreHorizontal strokeWidth={1.5} />
            </Button>
          )}
        </div>
      )}

      {entry && (
        <Popover
          anchor={moreRef}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          align="right"
          minWidth={200}
          estimatedWidth={200}
          ariaLabel={`More for ${name}`}
          className={PEOPLE_LAYER_CLASS}
        >
          <PopoverMenuItem
            label="Hide"
            onSelect={() => {
              setMenuOpen(false);
              void forget();
            }}
          />
        </Popover>
      )}
    </div>
  );
}

/**
 * The person card as a popover anchored to whatever was clicked (an avatar,
 * a name). Marked as a people layer, so it can open from inside the share
 * popover, and it keeps itself open for its own ⋯ menu. The Room
 * transcript can use this as is.
 */
export function PersonCardPopover({
  person,
  anchor,
  open,
  onClose,
  align = 'left',
}: {
  person: PersonRef;
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      role="dialog"
      align={align}
      gap={6}
      estimatedWidth={320}
      minWidth={320}
      ariaLabel={person.name ?? 'Person'}
      className={cn(PEOPLE_LAYER_CLASS, 'py-0')}
      keepOpenOn={insidePeopleLayer}
    >
      <PersonCard person={person} onClose={onClose} />
    </Popover>
  );
}
