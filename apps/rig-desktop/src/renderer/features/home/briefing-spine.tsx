import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Circle, FolderOpen, Send, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { relativeTime } from '@renderer/features/chat/session-history';
import { rpc } from '@renderer/lib/ipc';
import { SafeMarkdown } from '@renderer/lib/ui/comment-markdown';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import type {
  RigAskAnswer,
  RigAskSource,
  RigPulseBriefing,
  RigPulseError,
  RigPulsePerRig,
  RigPulsePickBackUp,
} from '@shared/rig/pulse';
import { resolveRigNameClick } from './home-sections';
import { composeGreeting, firstNameOf } from './greeting';
import {
  askErrorMessage,
  deriveAskSourceItems,
  derivePulseSectionState,
  isPulseStale,
  splitPickBackUp,
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
 * the same), the ONE summary sentence, the ask box with the web's three
 * suggestion chips (grounded — they prefill AND submit, not decorative),
 * then WHAT'S NEW: the pick-back-up items as quiet lines (design-system
 * Rule 9 — never the web's big bordered cards), capped to ~3 fresh ones
 * with older items behind a muted "+ N older" expander (`splitPickBackUp`),
 * and ACROSS YOUR RIGS below it (the pulse response's own `perRig[]`).
 *
 * The greeting/salutation is composed LOCALLY (`greeting.ts`'s own header
 * comment has the full story — "Good morning, Dylan." at 3PM was pulse's
 * own cached, server-timezone `greeting` string) from the viewer's clock
 * and the account profile's name; the summary sentence is still pulse's.
 *
 * Auto-refresh round (Dylan — kill the awkward Refresh button): no manual
 * trigger needed for the common case. `refetchOnWindowFocus` + a slow
 * `refetchInterval` quietly refetch a PLAIN (cache-respecting) copy in the
 * background; `forceRefresh` below additionally self-heals by forcing ONE
 * real regeneration (`refresh: true`) the moment a fetch resolves with a
 * `generatedAt` older than the relay's own ~3h TTL (`isPulseStale`) — a
 * plain refetch can still hand back a briefing the relay hasn't
 * regenerated in a while if nobody's been active. The old button is now a
 * quiet mono "updated Xh ago" line in its place — automatic by default,
 * `forceRefresh` still reachable by clicking it, whisper-quiet rather than
 * shouted with button chrome.
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
}: {
  /**
   * Bindings this device already has, for resolving a rig-name LINK
   * (`resolveRigNameClick`, WHAT'S NEW/ACROSS YOUR RIGS/Ask sources all use
   * it) AND — round 2 — for resolving a rig NAME for an Ask source
   * (`rigNameOf` below): `RigAskSource` itself carries no rig name, only a
   * `bindingId` (confirmed against the wire shape, not assumed).
   */
  localRigs: readonly { bindingId: string; path: string; name: string | null }[];
  onOpenPath: (path: string) => void;
  /** Scrolls to/flashes the matching row in `RigsRail` (`home.tsx`'s own state) — the relay-only half of a rig-name link. */
  onHighlightRig: (bindingId: string) => void;
}) {
  const queryClient = useQueryClient();
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
  const [refreshing, setRefreshing] = useState(false);
  // Guards re-entrancy for the auto-force effect below without needing to
  // be a `useEffect` dependency (a ref, unlike `refreshing` state, is
  // exempt from exhaustive-deps — reading/writing it never goes stale).
  const forcingRef = useRef(false);

  const state = derivePulseSectionState({ isLoading: pulseQuery.isLoading, data: pulseQuery.data });

  const forceRefresh = useCallback(async () => {
    if (forcingRef.current) return;
    forcingRef.current = true;
    setRefreshing(true);
    try {
      const result = await rpc.rig.pulse.get({ refresh: true });
      queryClient.setQueryData(PULSE_QUERY_KEY, result);
    } finally {
      forcingRef.current = false;
      setRefreshing(false);
    }
  }, [queryClient]);

  // Self-heal: the moment a fetch (first load, window-focus refetch, the
  // slow interval) resolves with a briefing older than the relay's own
  // TTL, force one real regeneration rather than silently keep showing it.
  // A freshly-forced result's OWN `generatedAt` reads as not-stale on the
  // next run, so this naturally stops re-firing once it has.
  useEffect(() => {
    if (!pulseQuery.data?.success) return;
    if (!isPulseStale(pulseQuery.data.data.briefing.generatedAt, Date.now())) return;
    void forceRefresh();
  }, [pulseQuery.data, forceRefresh]);

  const onClickRig = useCallback(
    (bindingId: string) => {
      const action = resolveRigNameClick(bindingId, localRigs);
      if (action.kind === 'open') onOpenPath(action.path);
      else onHighlightRig(action.bindingId);
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
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {/*
           * E fix: the greeting used to render as soon as `state` resolved,
           * independent of `meQuery` (a genuinely separate query) —
           * `firstName` would then pop in a moment later once `meQuery`
           * ALSO resolved, if it happened to be slower. Waiting on BOTH
           * here means the first time `Header` renders at all, `firstName`
           * is already its final value; rendering salutation-only (no
           * name) during THIS combined loading window is fine — it just
           * never changes to a name afterward.
           */}
          {state.kind === 'loading' || meQuery.isLoading ? (
            <HeaderSkeleton />
          ) : state.kind === 'error' ? (
            <p className="text-text-muted font-mono text-xs">{state.message}</p>
          ) : (
            <Header hour={hour} firstName={firstName} summary={state.kind === 'data' ? state.briefing.summary : ''} />
          )}
        </div>
        {state.kind === 'data' && (
          // Auto-refresh round: the line IS the status ("updated Xh ago"),
          // always there, quiet mono — clicking it forces a real refresh.
          // No button chrome; same quiet-text-button convention WHAT'S
          // NEW's own "+ N older" expander already uses (`hover:text-
          // text-primary`, no border/background of its own).
          <button
            type="button"
            onClick={() => void forceRefresh()}
            disabled={refreshing}
            aria-label="Refresh pulse"
            className="text-text-muted hover:text-text-primary shrink-0 font-mono text-xs transition-colors disabled:opacity-50"
          >
            {refreshing ? 'updating…' : `updated ${relativeTime(Date.parse(state.briefing.generatedAt), Date.now())}`}
          </button>
        )}
      </div>

      <PulseAsk onClickRig={onClickRig} rigNameOf={rigNameOf} />

      {state.kind === 'data' ? (
        <>
          <WhatsNew briefing={state.briefing} onClickRig={onClickRig} />
          <AcrossYourRigs perRig={state.briefing.perRig} onClickRig={onClickRig} />
        </>
      ) : (
        state.kind === 'empty' && (
          <p className="text-text-muted font-mono text-xs">Nothing new across your rigs.</p>
        )
      )}
    </div>
  );
}

/** Mono uppercase date kicker + a LOCALLY composed display greeting (see this file's own header comment) + the one summary sentence (still pulse's). */
function Header({ hour, firstName, summary }: { hour: number; firstName: string | null; summary: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-text-muted font-mono text-xs tracking-wide uppercase">{dateKicker()}</p>
      <h1 className="font-display text-text-primary text-2xl leading-snug">{composeGreeting(hour, firstName)}</h1>
      {summary && <p className="text-text-muted text-sm leading-relaxed">{summary}</p>}
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
 * WHAT'S NEW — pick-back-up items (perPerson moved out to `PeopleRail`;
 * perRig gets its OWN section below, `AcrossYourRigs` — restored round:
 * the web home's "Across your rigs" section, dropped when this app's Home
 * restructure folded activity into each rig's own row, but the pulse
 * response's own `perRig[]` is genuinely different information — cross-
 * rig activity, not per-rig recency). Quiet lines, never cards: a primary
 * line (the model's "why," falling back to the intent title) plus a muted
 * subtext (the rig name — now a LINK, see `RigNameLink` — and relative
 * time). Says "nothing new" honestly, itself, when there's genuinely
 * nothing to pick back up — a rig can carry real `perRig`/`perPerson`
 * activity (which is why the top-level state is `'data'`, not `'empty'`)
 * while still having no open intents to surface here.
 */
function WhatsNew({
  briefing,
  onClickRig,
}: {
  briefing: RigPulseBriefing;
  onClickRig: (bindingId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const now = Date.now();
  const { shown, older } = splitPickBackUp(briefing.pickBackUp, now);

  if (shown.length === 0 && older.length === 0 && !briefing.degraded) {
    return <p className="text-text-muted font-mono text-xs">Nothing new across your rigs.</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-text-muted font-mono text-xs tracking-wide uppercase">What&apos;s new</p>
      <div className="flex flex-col gap-3">
        {shown.map((p) => (
          <PickBackUpLine key={p.intentId} item={p} now={now} onClickRig={onClickRig} />
        ))}
        {expanded && older.map((p) => <PickBackUpLine key={p.intentId} item={p} now={now} onClickRig={onClickRig} />)}
      </div>
      {older.length > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-text-muted hover:text-text-primary self-start font-mono text-xs transition-colors"
        >
          + {older.length} older
        </button>
      )}
      {briefing.degraded && (
        <p className="text-text-muted text-xs">
          Showing a plain digest. Richer narration needs the relay&apos;s LLM key.
        </p>
      )}
    </div>
  );
}

function PickBackUpLine({
  item,
  now,
  onClickRig,
}: {
  item: RigPulsePickBackUp;
  now: number;
  onClickRig: (bindingId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-text-primary text-[13px] leading-relaxed">{item.why || item.title}</p>
      <p className="text-text-muted font-mono text-xs">
        <RigNameLink bindingId={item.bindingId} name={item.rigName} onClick={onClickRig} />
        {' · '}
        {relativeTime(new Date(item.at).getTime(), now)}
      </p>
    </div>
  );
}

/**
 * ACROSS YOUR RIGS — the web home's own section, restored (Dylan): the
 * pulse response's `perRig[]`, one narrated line per rig with recent
 * activity, same quiet-line style as WHAT'S NEW right above it (not a
 * duplicate of it — WHAT'S NEW is open INTENTS worth resuming; this is
 * general recent activity per rig, whether or not there's an open intent
 * behind it). Absent entirely when `perRig` is empty — no "nothing here"
 * chrome for a section that's allowed to just not apply.
 */
function AcrossYourRigs({
  perRig,
  onClickRig,
}: {
  perRig: readonly RigPulsePerRig[];
  onClickRig: (bindingId: string) => void;
}) {
  if (perRig.length === 0) return null;
  const now = Date.now();

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-text-muted font-mono text-xs tracking-wide uppercase">Across your rigs</p>
      <div className="flex flex-col gap-3">
        {perRig.map((p) => (
          <PerRigLine key={p.bindingId} item={p} now={now} onClickRig={onClickRig} />
        ))}
      </div>
    </div>
  );
}

function PerRigLine({
  item,
  now,
  onClickRig,
}: {
  item: RigPulsePerRig;
  now: number;
  onClickRig: (bindingId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-text-primary text-[13px] leading-relaxed">{item.line}</p>
      <p className="text-text-muted font-mono text-xs">
        <RigNameLink bindingId={item.bindingId} name={item.rigName} onClick={onClickRig} />
        {item.at && (
          <>
            {' · '}
            {relativeTime(new Date(item.at).getTime(), now)}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The rig-name mono chip, shared by WHAT'S NEW and ACROSS YOUR RIGS — a
 * LINK now, not inert text (Dylan's polish round). `onClick` is
 * `BriefingSpine`'s own `onClickRig` (`resolveRigNameClick`'s render-side
 * wiring): a local match opens it via the normal `openPath` flow, a
 * relay-only one scrolls to/flashes its row in `RigsRail` instead — this
 * component itself doesn't know or care which happens, it just names the
 * rig and reports the click.
 */
function RigNameLink({
  bindingId,
  name,
  onClick,
}: {
  bindingId: string;
  name: string;
  onClick: (bindingId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(bindingId)}
      className="hover:text-text-primary underline decoration-dotted underline-offset-2 transition-colors"
    >
      {name}
    </button>
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
  onClickRig,
  rigNameOf,
}: {
  onClickRig: (bindingId: string) => void;
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
            placeholder="Ask across your rigs…"
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
          onClickRig={onClickRig}
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
  onClickRig,
  rigNameOf,
}: {
  question: string;
  asking: boolean;
  answer: RigAskAnswer | null;
  error: RigPulseError | null;
  onClear: () => void;
  onClickRig: (bindingId: string) => void;
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
            textClassName="text-[9px]"
            className="mt-0.5 shrink-0"
          />
          <p className="text-text-primary min-w-0 text-[13px] leading-relaxed">{question}</p>
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
        <p className="text-text-muted animate-pulse pl-7 text-[13px]">Thinking…</p>
      ) : error ? (
        <p className="text-danger pl-7 text-[13px]">{askErrorMessage(error)}</p>
      ) : (
        answer && (
          <div className="flex flex-col gap-2 pl-7">
            <SafeMarkdown content={answer.answer} className="text-[13px]" />
            {answer.sources.length > 0 && (
              <AskSourcesSection sources={answer.sources} rigNameOf={rigNameOf} onClickRig={onClickRig} />
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
  onClickRig,
}: {
  sources: readonly RigAskSource[];
  rigNameOf: (bindingId: string) => string | null;
  onClickRig: (bindingId: string) => void;
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
      className="text-text-muted hover:text-text-primary flex items-center gap-1 font-mono text-[11px] transition-colors"
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
            <SourceRow key={item.ref} item={item} onClickRig={onClickRig} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One expanded row (not a pill). A `'rig'` item's title IS the rig's own
 * name, so the whole row links (`onClickRig`); an `'intent'` item has no
 * honest destination of its own — only its OWNING rig does — so the row
 * stays non-interactive and just the mono rig-name sub-label links, same
 * behavior `RigNameLink` (WHAT'S NEW) already uses. No status icon: the
 * ask response carries no intent status at all (verified, not assumed —
 * see `pulse-state.ts`), so every intent gets the same neutral `Circle`
 * rather than a fabricated open/closed distinction.
 */
function SourceRow({
  item,
  onClickRig,
}: {
  item: AskSourceListItem;
  onClickRig: (bindingId: string) => void;
}) {
  if (item.kind === 'rig') {
    return (
      <button
        type="button"
        onClick={() => onClickRig(item.bindingId)}
        className="group flex items-start gap-2 text-left"
      >
        <FolderOpen className="text-text-muted mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
        <span className="text-text-primary group-hover:text-accent min-w-0 flex-1 text-[12.5px] leading-snug transition-colors">
          {item.title}
        </span>
      </button>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <Circle className="text-text-muted mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
      <div className="min-w-0 flex-1">
        <p className="text-text-primary text-[12.5px] leading-snug">{item.title}</p>
        <button
          type="button"
          onClick={() => onClickRig(item.bindingId)}
          className="text-text-muted hover:text-text-primary font-mono text-[10px] underline decoration-dotted underline-offset-2 transition-colors"
        >
          {item.rigName ?? 'this rig'}
        </button>
      </div>
    </div>
  );
}
