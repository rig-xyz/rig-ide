import githubIcon from '@iconify-icons/logos/github-icon';
import calendarIcon from '@iconify-icons/logos/google-calendar';
import gmailIcon from '@iconify-icons/logos/google-gmail';
import linearIcon from '@iconify-icons/logos/linear-icon';
import notionIcon from '@iconify-icons/logos/notion-icon';
import slackIcon from '@iconify-icons/logos/slack-icon';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { SOURCES } from './mock';
import { type Person, type RailSession, sessionMatrix, type SourceConnector } from './model';

/** Small pieces the rail, the middle and the Feed share. */

/**
 * The source marks: real brand logos from svg-logos (`@iconify-icons/logos`,
 * CC0), one module per logo. Linear and GitHub ship in dark ink, so Linear
 * takes its indigo and GitHub the theme's ink; Notion keeps its own black on
 * white. Granola isn't in any logo set: its leaf stays drawn by hand.
 */
const MARKS = {
  slack: slackIcon,
  gmail: gmailIcon,
  linear: { ...linearIcon, body: linearIcon.body.replaceAll('fill="#222326"', 'fill="#5e6ad2"') },
  github: { ...githubIcon, body: githubIcon.body.replaceAll('fill="#161614"', 'fill="currentColor"') },
  calendar: calendarIcon,
  notion: notionIcon,
} as const;
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
  if (connector !== 'granola') {
    const mark = MARKS[connector];
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${mark.width} ${mark.height}`}
        aria-hidden
        className={cn('block shrink-0', connector === 'github' && 'text-text-primary', className)}
        // The library's own SVG markup, from a pinned package: not user content.
        dangerouslySetInnerHTML={{ __html: mark.body }}
      />
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={cn('block shrink-0', className)}>
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
