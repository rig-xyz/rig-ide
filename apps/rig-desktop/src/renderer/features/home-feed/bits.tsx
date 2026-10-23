import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { SOURCES } from './mock';
import { type Person, type RailSession, sessionMatrix, type SourceConnector } from './model';

/** Small pieces the rail, the middle and the Feed share. */

/** The source marks from the approved prototype: Linear's disc, GitHub's cat, Granola's leaf. */
const LINEAR = { disc: '#5e6ad2', ink: '#ffffff' };
const GRANOLA = { tile: '#2f7d4f', ink: '#ffffff' };

export function SourceLogo({
  connector,
  size = 15,
  className,
}: {
  connector: SourceConnector;
  size?: number;
  className?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    'aria-hidden': true,
    className: cn('block shrink-0', className),
  };
  if (connector === 'linear') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10.5" fill={LINEAR.disc} />
        <path
          d="M4.6 13.6l5.8 5.8M4.3 9.9l9.8 9.8M5.9 6.6l11.5 11.5M9.3 4.6l10.1 10.1"
          stroke={LINEAR.ink}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (connector === 'slack') {
    return (
      <svg {...common}>
        <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#4a154b" />
        <path d="M9 6.5v6M15 11.5v6M6.5 15h6M11.5 9h6" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (connector === 'gmail') {
    return (
      <svg {...common}>
        <rect x="1.5" y="4" width="21" height="16" rx="3" fill="#ffffff" stroke="#d6dae0" />
        <path d="M3 6.5l9 7 9-7" stroke="#ea4335" strokeWidth="2" fill="none" strokeLinejoin="round" />
      </svg>
    );
  }
  if (connector === 'granola') {
    return (
      <svg {...common}>
        <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill={GRANOLA.tile} />
        <path
          d="M8 15.5c0-4 3-7 8-7.5-.4 5-3.6 8.3-7.6 8.3M8 15.5l-1.5 2"
          stroke={GRANOLA.ink}
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common} className={cn('block shrink-0 text-text-primary', className)}>
      <path
        fill="currentColor"
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"
      />
    </svg>
  );
}

export function sourceName(connector: SourceConnector): string {
  return SOURCES[connector].name;
}

/** One letter, the way the prototype draws faces. */
function initials(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? '?';
}

/** A person's face: their initial on their own color. */
export function Face({
  person,
  size = 18,
  className,
}: {
  person: Pick<Person, 'name' | 'hue' | 'note' | 'avatarUrl'>;
  size?: 18 | 20 | 24 | 28;
  className?: string;
}) {
  const box = cn(
    'shrink-0 rounded-full',
    size === 18 && 'size-[18px]',
    size === 20 && 'size-5',
    size === 24 && 'size-6',
    size === 28 && 'size-7',
    className
  );
  if (person.avatarUrl) {
    return (
      <img
        src={person.avatarUrl}
        alt=""
        title={person.note ?? person.name}
        className={cn(box, 'object-cover')}
      />
    );
  }
  return (
    <span
      title={person.note ?? person.name}
      style={{ background: `var(--face-${person.hue})` }}
      className={cn(
        'text-face-ink grid shrink-0 place-items-center rounded-full font-semibold',
        size === 18 && 'size-[18px] text-face',
        size === 20 && 'size-5 text-face',
        size === 24 && 'size-6 text-face',
        size === 28 && 'size-7 text-2xs',
        className
      )}
    >
      {initials(person.name)}
    </span>
  );
}

/** A rail count: quiet grey, or the accent when it's things waiting on you. */
export function Count({
  n,
  accent,
  className,
}: {
  n: number;
  accent?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-block h-[18px] min-w-[18px] rounded-[9px] px-[5px] text-center text-kicker leading-[18px] font-semibold',
        accent ? 'bg-accent text-accent-ink' : 'bg-bg-3 text-text-secondary',
        className
      )}
    >
      {n}
    </span>
  );
}

/** A session's dot matrix, in the tone its state carries. */
export function SessionMatrix({
  session,
  size = 'md',
  className,
}: {
  session: Pick<RailSession, 'state' | 'activity'>;
  size?: 'sm' | 'md' | 'xl';
  className?: string;
}) {
  const { state, tone } = sessionMatrix(session);
  return <DotMatrix state={state} tone={tone} size={size} className={className} />;
}

/** The small mono kicker over a section: "SPACES", "NEEDS YOU", "ACTIVITY". */
export function Kicker({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'font-mono text-kicker font-medium tracking-[0.1em] text-text-muted uppercase',
        className
      )}
    >
      {children}
    </div>
  );
}

/** The status word at the right of a hover card or a context header. */
export function StatusWord({
  text,
  tone,
}: {
  text: string;
  tone: 'warn' | 'live' | 'ok' | 'muted';
}) {
  return (
    <span
      className={cn(
        'font-mono text-2xs font-medium tracking-[0.06em] whitespace-nowrap uppercase',
        tone === 'warn' && 'text-status-warn',
        tone === 'live' && 'text-accent',
        tone === 'ok' && 'text-status-ok',
        tone === 'muted' && 'text-text-muted'
      )}
    >
      {text}
    </span>
  );
}

/**
 * An icon-only button, the one both panel toggles use (the rail's and the
 * Feed's), so folding either side works the same way. Its icon nudges the
 * way it points. Never a drag handle, even inside the window's drag strip.
 */
export function IconButton({
  label,
  dir,
  onClick,
  children,
  className,
}: {
  label: string;
  dir?: 'left' | 'right';
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-dir={dir}
      onClick={onClick}
      className={cn(
        'hf-nudge relative grid size-7 shrink-0 place-items-center rounded-control text-text-secondary transition-colors [-webkit-app-region:no-drag] hover:bg-bg-2 hover:text-text-primary',
        className
      )}
    >
      {children}
    </button>
  );
}
