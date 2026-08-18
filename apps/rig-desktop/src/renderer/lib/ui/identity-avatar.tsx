import { UserRound } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

/**
 * A person's avatar, or an initials monogram when there's no `avatarUrl` —
 * the common case, since most relays/providers don't ship one. Ported from
 * `apps/emdash-desktop`'s `rig-identity-chip.tsx` (`IdentityAvatar`), used
 * there for the signed-in account and here for `@mention` menu rows and
 * anywhere else a person needs to be pictured. The generic person glyph is
 * the last resort, only when there's no name to draw a monogram from either.
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

export function IdentityAvatar({
  name,
  avatarUrl,
  sizeClassName = 'size-4',
  textClassName = 'text-[8px]',
  className,
}: {
  name: string | null;
  avatarUrl: string | null;
  sizeClassName?: string;
  textClassName?: string;
  className?: string;
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className={cn('shrink-0 rounded-full', sizeClassName, className)}
      />
    );
  }
  // No name to draw initials from — a monogram of a placeholder label would
  // read as someone else's initials.
  if (!name) return <UserRound className={cn('shrink-0', sizeClassName, className)} />;
  return (
    <span
      className={cn(
        'bg-bg-2 text-text-secondary flex shrink-0 items-center justify-center rounded-full font-medium',
        sizeClassName,
        textClassName,
        className
      )}
    >
      {initials(name)}
    </span>
  );
}
