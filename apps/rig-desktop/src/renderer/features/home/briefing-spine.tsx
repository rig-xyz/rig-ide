import { useQuery } from '@tanstack/react-query';
import { Bot, ChevronRight, Circle, FileText, FolderOpen, MessageSquare, Send, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { SafeMarkdown } from '@renderer/lib/ui/comment-markdown';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import type { RigAskAnswer, RigAskSource, RigPulseError } from '@shared/rig/pulse';
import { composeGreeting, firstNameOf } from './greeting';
import {
  askErrorMessage,
  deriveAskSourceItems,
  derivePulseSectionState,
  resolveAskSourceClick,
  summarizeAskSources,
  type AskSourceListItem,
} from './pulse-state';

export const PULSE_QUERY_KEY = ['rig', 'pulse', 'get'];

const ASK_SUGGESTIONS = ["What's blocked?", 'What shipped recently?', 'What should I pick up next?'];

/** A "slow" background nudge for a window left open unattended — window focus covers the realistic "came back to check" moment; this covers the rest, without hammering the relay. */
const PULSE_REFETCH_INTERVAL_MS = 20 * 60 * 1000;

/**
 * Round: HOME RESTRUCTURE — the center region, the briefing spine. Web
 * hub home's structural reference (`hub/web`'s `PulseBriefing`/`AskBox`),
 * restyled to this app's tokens, not copied: a mono date kicker, a
 * display-font greeting (`font-display` is legitimate here — the web does
 * the same), the ask box with its own suggestion chips (grounded — they
 * prefill AND submit, not decorative).
 *
 * Polish round, lane C ("spaces first"): WHAT'S NEW (pick-back-up items)
 * and the old quiet-line ACROSS YOUR RIGS moved OUT of this component —
 * the approved mock replaces them with `needs-you-section.tsx`'s "Needs
 * you", rendered by `home.tsx` directly below this one (it needs
 * space-status/self-user data this component has no reason to carry). This component's own scope
 * is back to exactly what the design doc's main-column list says it keeps:
 * "the Pulse summary paragraph... the Ask box + suggestion pills".
 *
 * The greeting/salutation is composed LOCALLY (`greeting.ts`'s own header
 * comment has the full story — "Good morning, Dylan." at 3PM was pulse's
 * own cached, server-timezone `greeting` string) from the viewer's clock
 * and the account profile's name.
 *
 * "Many spaces on Home" v2: pulse's summary sentence ("across your rigs"),
 * its "updated Xh ago" line and the forced regeneration behind it are gone.
 * `across-your-spaces-today.tsx` says what happened instead, from the
 * relay's Room themes. The briefing is still read (plain, cache-respecting)
 * for `PeopleRail` and to name an Ask source's rig.
 *
 * Self-contained (owns its own fetch) — `PeopleRail` reads the SAME query
 * key independently; React Query dedupes the cache entry, so this is one
 * real fetch, not two. Only mounted when `shouldShowPulseSection` says so
 * (`home.tsx`).
 */
export function BriefingSpine({
  localRigs,
  onOpenPath,
  onHighlightRig,
  showGreeting = true,
}: {
  /** Home renders the greeting itself, spanning both columns (`HomeGreeting`); other callers keep it here. */
  showGreeting?: boolean;
  /**
   * Bindings this device already has, for resolving an Ask source's link
   * AND — round 2 — for resolving a rig NAME for
   * an Ask source (`rigNameOf` below): `RigAskSource` itself carries no
   * rig name, only a `bindingId` (confirmed against the wire shape, not
   * assumed).
   */
  localRigs: readonly { bindingId: string; path: string; name: string | null }[];
  /**
   * File-mention round: widened to take an optional `openFilePath` (an
   * absolute path) alongside the rig path — `onOpenFile` below is the only
   * caller that ever passes one. The real function behind this prop
   * (`App.tsx`'s `openPath`) already accepts it; this is just this
   * component being honest about the shape it actually calls.
   */
  onOpenPath: (path: string, opts?: { openFilePath?: string }) => void;
  /** Scrolls to/flashes the matching row in `RigsRail` (`home.tsx`'s own state) — the relay-only half of an Ask source's link. */
  onHighlightRig: (bindingId: string) => void;
}) {
  const pulseQuery = useQuery({
    queryKey: PULSE_QUERY_KEY,
    queryFn: () => rpc.rig.pulse.get({}),
    staleTime: 60_000,
    // Explicit rather than relying on QueryClient's own default (which
    // happens to already be `true`) — this is a designed behavior here,
    // not an accident of global defaults surviving unnoticed.
    refetchOnWindowFocus: true,
    refetchInterval: PULSE_REFETCH_INTERVAL_MS,
  });
  // Nitpick fix: "Good morning, Dylan." at 3PM — the salutation used to be
  // whatever pulse's own `greeting` string said (server timezone,
  // generation-time, cached up to 3h). Composed locally instead: the
  // viewer's own clock (`useCurrentHour`) + the account profile's real
  // name — never parsed out of pulse's own string. `greeting` stays in
  // the wire type for other consumers; this component just stops
  // rendering it.
  const meQuery = useQuery({ queryKey: ['rig', 'account', 'me'], queryFn: () => rpc.rig.account.me() });
  const firstName = meQuery.data?.success ? firstNameOf(meQuery.data.data.name) : null;
  const hour = useCurrentHour();
  const state = derivePulseSectionState({ isLoading: pulseQuery.isLoading, data: pulseQuery.data });

  // An Ask source opens where it came from: its file (a change), else its rig or space.
  const onClickSource = useCallback(
    (item: AskSourceListItem) => {
      const action = resolveAskSourceClick(item, localRigs);
      if (action.kind === 'highlight') onHighlightRig(action.bindingId);
      else onOpenPath(action.path, action.openFilePath ? { openFilePath: action.openFilePath } : undefined);
    },
    [localRigs, onOpenPath, onHighlightRig]
  );

  // Ask-sources round: the ask response has no rig name of its own, only a
  // `bindingId` — resolved from whatever THIS component already knows: the
  // local rig list first, then the SAME briefing's own `pickBackUp`/`perRig`
  // (both already carry `bindingId → rigName` for anything pulse has
  // activity on). A binding truly outside all three degrades to `null`,
  // never a guessed name (`deriveAskSourceItems`, `pulse-state.ts`).
  const rigNameOf = useCallback(
    (bindingId: string): string | null => {
      const local = localRigs.find((r) => r.bindingId === bindingId)?.name ?? null;
      if (local) return local;
      if (state.kind !== 'data') return null;
      return (
        state.briefing.pickBackUp.find((p) => p.bindingId === bindingId)?.rigName ??
        state.briefing.perRig.find((p) => p.bindingId === bindingId)?.rigName ??
        null
      );
    },
    [localRigs, state]
  );

  return (
    <div className="flex w-full flex-col gap-6 text-left">
      {/*
       * The greeting waits on the account so the name never pops in after
       * it. Pulse's "across your rigs" summary sentence and its "updated"
       * line are gone: "Across your spaces today" below the Ask box
       * (`across-your-spaces-today.tsx`) says what happened, from the
       * relay's Room themes, with no model call of its own.
       */}
      {showGreeting && (meQuery.isLoading ? <HeaderSkeleton /> : <Header hour={hour} firstName={firstName} />)}

      <PulseAsk onClickSource={onClickSource} rigNameOf={rigNameOf} />
    </div>
  );
}

/** The date and greeting on their own, for Home to place across both columns. */
export function HomeGreeting() {
  const meQuery = useQuery({ queryKey: ['rig', 'account', 'me'], queryFn: () => rpc.rig.account.me() });
  const firstName = meQuery.data?.success ? firstNameOf(meQuery.data.data.name) : null;
  const hour = useCurrentHour();
  return meQuery.isLoading ? <HeaderSkeleton /> : <Header hour={hour} firstName={firstName} />;
}

/** Mono uppercase date kicker + a LOCALLY composed display greeting (see this file's own header comment). */
function Header({ hour, firstName }: { hour: number; firstName: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-text-muted font-mono text-xs tracking-wide uppercase">{dateKicker()}</p>
      <h1 className="font-display text-text-primary text-2xl leading-snug">{composeGreeting(hour, firstName)}</h1>
    </div>
  );
}

/** e.g. "SATURDAY, AUGUST 15" — CSS uppercase over a plain locale string, same as the web's own `todayLabel`. */
function dateKicker(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * The local hour, re-derived on an hourly tick so a salutation can't go
 * stale while the window just sits open across a morning/afternoon/evening
 * boundary. A minute-precision timer would be overkill (the boundaries are
 * hour-granular); crossing one within the same hour it's checked is an
 * acceptable, honest imprecision — this is a courtesy greeting, not a clock.
 */
function useCurrentHour(): number {
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const id = setInterval(() => setHour(new Date().getHours()), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  return hour;
}

function HeaderSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-bg-2 h-2.5 w-32 animate-pulse rounded-control" />
      <div className="bg-bg-2 h-6 w-2/3 animate-pulse rounded-control" />
      <div className="bg-bg-2 h-3.5 w-1/2 animate-pulse rounded-control" />
    </div>
  );
}

/**
 * Ask across the fabric — a question box, not a session composer. The
 * composer-cockpit rules (design-system rule 8) apply scaled down and
 * honestly: no harness identity chip here, because the answer comes from
 * the relay's own model call, not a local agent. The three suggestion
 * chips mirror the web's own — muted mono, and grounded: clicking one
 * submits that exact question immediately, it doesn't just prefill the box
 * for the user to send themselves.
 *
 * Answer-surface round (Dylan's screenshot, four problems treated as one
 * pass — see `QuestionAndAnswer` below for the actual zone): `error` now
 * keeps the full `RigPulseError`, not just its `.message` — `askErrorMessage`
 * (`pulse-state.ts`) needs `.status` to add the verified 40/hour line for a
 * 429, not just whatever string the relay happened to send.
 */
function PulseAsk({
  onClickSource,
  rigNameOf,
}: {
  onClickSource: (item: AskSourceListItem) => void;
  rigNameOf: (bindingId: string) => string | null;
}) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<RigAskAnswer | null>(null);
  const [error, setError] = useState<RigPulseError | null>(null);

  const runAsk = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || asking) return;
    setQuestion(trimmed);
    setAsking(true);
    setError(null);
    setAnswer(null);
    setAsked(trimmed);
    const result = await rpc.rig.pulse.ask({ question: trimmed });
    setAsking(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setAnswer(result.data);
    setQuestion('');
  };

  const clear = () => {
    setAsked(null);
    setAnswer(null);
    setError(null);
    setQuestion('');
  };

  const idle = !asked;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {/* Ask-button round (Dylan — match the app's button language): the
            inline text+icon affordance used to sit unbounded inside the
            input's own row, reading as an odd one-off. `Button` (the same
            component the composer's own Send uses) now sits INSIDE that
            chrome, `size="sm"` so its 28px height fits the row without the
            input needing its own border — Enter-to-submit is unchanged,
            it's native `<form onSubmit>` behavior, not something the
            button itself has to provide. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runAsk(question);
          }}
          className="border-border-hairline focus-within:border-accent bg-bg-1 flex items-center gap-2 rounded-control border py-1.5 pr-1.5 pl-3 transition-colors"
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask across your spaces…"
            disabled={asking}
            className="text-text-primary placeholder:text-text-muted min-w-0 flex-1 bg-transparent text-sm outline-none disabled:cursor-not-allowed"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={asking || !question.trim()}>
            <Send className="size-3.5" strokeWidth={1.5} />
            Ask
          </Button>
        </form>

        {idle && (
          <div className="flex flex-wrap gap-1.5">
            {ASK_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void runAsk(s)}
                className="border-border-hairline text-text-muted hover:text-text-primary hover:border-border-strong rounded-chip border px-2 py-1 font-mono text-xs transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {asked && (
        <QuestionAndAnswer
          question={asked}
          asking={asking}
          answer={answer}
          error={error}
          onClear={clear}
          onClickSource={onClickSource}
          rigNameOf={rigNameOf}
        />
      )}
    </div>
  );
}

/**
 * The Q&A zone — Dylan's four problems, one surface:
 *
 * 1. Markdown: `SafeMarkdown` (the comments feature's own safe-markdown
 *    stack, extracted for reuse — `lib/ui/comment-markdown.tsx`) instead of
 *    raw `**text**`/`- ` prose. Sized to this surface's own 13px scale (not
 *    the comments feature's 14px default) — quiet, an answer, not a
 *    document.
 * 2. The question: the account's own avatar (`IdentityAvatar`, same
 *    account query `BriefingSpine` already runs) beside the question text
 *    — unmistakably "you asked this," not a tiny label.
 * 3. Containment: a hairline-bounded zone (design-system Rule 3 — "cards
 *    must earn their border... a card is zones, not text in a rounded
 *    box"; Rule 5 — "hairlines separate, boxes are a last resort"). Top AND
 *    bottom hairlines read as an inserted section within the flow, not a
 *    bordered/radiused card. A quiet ⋅ close ⋅ (Rule 7's own icon-only
 *    carve-out) clears it back to Home's resting state.
 * 4. Sources: round 2 (Dylan: "I don't understand what it maps to?") —
 *    `AskSourcesSection` below replaces the chip wall entirely.
 */
function QuestionAndAnswer({
  question,
  asking,
  answer,
  error,
  onClear,
  onClickSource,
  rigNameOf,
}: {
  question: string;
  asking: boolean;
  answer: RigAskAnswer | null;
  error: RigPulseError | null;
  onClear: () => void;
  onClickSource: (item: AskSourceListItem) => void;
  rigNameOf: (bindingId: string) => string | null;
}) {
  const meQuery = useQuery({ queryKey: ['rig', 'account', 'me'], queryFn: () => rpc.rig.account.me() });
  const me = meQuery.data?.success ? meQuery.data.data : null;

  return (
    <div className="border-border-hairline flex flex-col gap-3 border-t border-b py-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <IdentityAvatar
            name={me?.name ?? me?.email ?? null}
            avatarUrl={me?.avatarUrl ?? null}
            sizeClassName="size-5"
            textClassName="text-2xs"
            className="mt-0.5 shrink-0"
          />
          <p className="text-text-primary min-w-0 text-sm leading-relaxed">{question}</p>
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear answer"
          className="text-text-muted hover:text-text-primary rounded-control flex shrink-0 items-center justify-center p-1 transition-colors"
        >
          <X className="size-3.5" strokeWidth={1.5} />
        </button>
      </div>

      {asking ? (
        <p className="text-text-muted animate-pulse pl-7 text-sm">Thinking…</p>
      ) : error ? (
        <p className="text-danger pl-7 text-sm">{askErrorMessage(error)}</p>
      ) : (
        answer && (
          <div className="flex flex-col gap-2 pl-7">
            <SafeMarkdown content={answer.answer} className="text-sm" />
            {answer.sources.length > 0 && (
              <AskSourcesSection sources={answer.sources} rigNameOf={rigNameOf} onClickSource={onClickSource} />
            )}
          </div>
        )
      )}
    </div>
  );
}

/**
 * Sources round 2 (Dylan: "I don't love the source section. I don't
 * understand what it maps to? What are the names? What are the docs? why a
 * lightbulb?"). Investigated in `~/Code/tap` (full findings in
 * `pulse-state.ts`'s own header comment): an INTENT is one work session on
 * a rig — the SAME thing WHAT'S NEW's pick-back-up items already are; a
 * MESSAGE is a team-channel post this app has no surface to browse at all,
 * so it's dropped from the UI entirely (recommendation, not silent —
 * `deriveAskSourceItems` filters it out with its own comment explaining
 * why).
 *
 * Collapsed by default to ONE quiet, self-explanatory line
 * (`summarizeAskSources`: real counts, real rig names, honest singular/
 * plural) — no chip wall. The line itself carries a one-sentence tooltip
 * explaining "intent" (only when the set actually contains one — a
 * rig-only citation set has nothing to explain), rather than a separate
 * label + a separate info icon.
 */
function AskSourcesSection({
  sources,
  rigNameOf,
  onClickSource,
}: {
  sources: readonly RigAskSource[];
  rigNameOf: (bindingId: string) => string | null;
  onClickSource: (item: AskSourceListItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = deriveAskSourceItems(sources, rigNameOf);
  if (items.length === 0) return null;

  const summary = summarizeAskSources(items);
  const trigger = (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      className="text-text-muted hover:text-text-primary flex items-center gap-1 font-mono text-2xs transition-colors"
    >
      <ChevronRight className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')} strokeWidth={1.5} />
      {summary}
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      {items.some((item) => item.kind === 'intent') ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent side="top" className="max-w-64 normal-case">
            An intent is the rig&apos;s own record of a work session — what an agent or person did, and why.
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      {expanded && (
        <div className="flex flex-col gap-2 pl-4">
          {items.map((item) => (
            <SourceRow key={item.ref} item={item} onClickSource={onClickSource} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One expanded row (not a pill), per cited source. Every row links back to
 * where it came from: a file change opens the file in its rig, a message or
 * an agent run opens its space, an intent its rig, a rig itself. The mono
 * sub-label names the rig or space. No status icon: the ask response
 * carries no intent status (see `pulse-state.ts`).
 */
const SOURCE_ICON = {
  rig: FolderOpen,
  intent: Circle,
  message: MessageSquare,
  session: Bot,
  change: FileText,
} as const;

const SOURCE_KIND_LABEL: Record<AskSourceListItem['kind'], string | null> = {
  rig: null,
  intent: null,
  message: 'Message',
  session: 'Agent run',
  change: 'File',
};

function SourceRow({
  item,
  onClickSource,
}: {
  item: AskSourceListItem;
  onClickSource: (item: AskSourceListItem) => void;
}) {
  const Icon = SOURCE_ICON[item.kind];
  const kindLabel = SOURCE_KIND_LABEL[item.kind];
  const title = item.kind === 'change' && item.path ? item.path : item.title;
  return (
    <button
      type="button"
      onClick={() => onClickSource(item)}
      className="group flex items-start gap-2 text-left"
      data-testid="ask-source"
      data-kind={item.kind}
    >
      <Icon className="text-text-muted mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
      <span className="min-w-0 flex-1">
        <span className="text-text-primary group-hover:text-accent block text-xs leading-snug transition-colors">
          {title}
        </span>
        {item.kind !== 'rig' && (
          <span className="text-text-muted font-mono text-2xs">
            {kindLabel ? `${kindLabel} · ` : ''}
            {item.rigName ?? 'this rig'}
          </span>
        )}
      </span>
    </button>
  );
}
