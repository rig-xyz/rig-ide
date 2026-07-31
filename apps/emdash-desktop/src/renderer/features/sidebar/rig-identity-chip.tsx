import { useQuery } from '@tanstack/react-query';
import { LogIn, UserRound } from 'lucide-react';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { cn } from '@renderer/utils/utils';

/**
 * Bottom-left identity chip. Signed out, it's a compact sign-in affordance
 * that runs the same flow as the onboarding step; signed in, it's an
 * avatar + name that opens Settings → Account.
 *
 * Both states share one row shape (a leading glyph, one line of truncated
 * text) at a fixed height, so the footer never wraps or shifts as sign-in
 * state changes. `avatarUrl` is null until the relay ships it, which is the
 * common case right now — the initials fallback is the default look here,
 * not an edge case.
 */

const ROW_CLASSNAME =
  'flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm text-foreground-muted hover:text-foreground focus:outline-none focus-visible:outline-none disabled:cursor-default disabled:opacity-60';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/**
 * Exported so Settings → Account can show the same avatar (with the same
 * generic-glyph fallback) at a larger size — `sizeClassName`/`textClassName`
 * default to the chip's own 16px look so this stays a no-op change here.
 */
export function IdentityAvatar({
  name,
  avatarUrl,
  sizeClassName = 'size-4',
  textClassName = 'text-[8px]',
}: {
  name: string | null;
  avatarUrl: string | null;
  sizeClassName?: string;
  textClassName?: string;
}) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className={cn('shrink-0 rounded-full', sizeClassName)} />;
  }
  // No name to draw initials from — a monogram of the placeholder label ("SR"
  // for "Signed in to Rig") would read as someone else's initials.
  if (!name) return <UserRound className={cn('shrink-0', sizeClassName)} />;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-background-2 font-medium text-foreground-muted',
        sizeClassName,
        textClassName
      )}
    >
      {initials(name)}
    </span>
  );
}

export function RigIdentityChip() {
  const { navigate } = useNavigate();
  const { data: status } = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = status?.signedIn ?? false;

  const { data: me } = useQuery({
    queryKey: ['rig', 'account', 'me'],
    queryFn: () => rpc.rig.account.me(),
    enabled: signedIn,
  });

  const { phase, signIn } = useRigSignIn();

  if (!signedIn) {
    return (
      <button
        type="button"
        className={ROW_CLASSNAME}
        onClick={() => void signIn()}
        disabled={phase !== 'idle'}
      >
        <LogIn className="size-4 shrink-0" />
        <span className="truncate">
          {phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
        </span>
      </button>
    );
  }

  const user = me?.success ? me.data : null;
  // `||`, not `??`: every one of these can be an empty string as well as null,
  // and an empty label renders as a blank chip rather than falling through.
  // Null when we genuinely have no identity to show — the relay's `email` is
  // nullable, and `name` is absent until the relay ships it.
  const label = user?.name || user?.email || null;

  return (
    <button
      type="button"
      className={ROW_CLASSNAME}
      onClick={() => navigate('settings', { tab: 'account' })}
      title={label ?? 'Signed in to Rig'}
    >
      <IdentityAvatar name={label} avatarUrl={user?.avatarUrl ?? null} />
      <span className="truncate">{label ?? 'Signed in to Rig'}</span>
    </button>
  );
}
