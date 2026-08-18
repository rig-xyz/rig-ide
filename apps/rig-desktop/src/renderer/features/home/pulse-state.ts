/**
 * Round H3 — pulse parity: the state→rendering decision for Home's pulse
 * regions, pure and side-effect free on purpose (same reasoning as
 * `home-sections.ts`'s own header comment) — the fetching/mutation wiring
 * lives in `briefing-spine.tsx`/`people-rail.tsx` (round: HOME
 * RESTRUCTURE), this is only "given what the pulse RPC returned, what do
 * we show."
 *
 * Four honest states, matching the brief's own list: `loading` (first
 * fetch, no cached data yet — a skeleton, not a spinner), `empty` (the
 * relay's own briefing came back with nothing to narrate), `error`
 * (couldn't load at all — offline/relay unreachable is one flavor, an
 * explicit "not signed in" is another), and `data` (a real briefing,
 * richly narrated or `degraded` — see `shared/rig/pulse.ts`'s own doc
 * comment on why `degraded: true` is a genuine 200, not an error).
 *
 * `empty` no longer carries `greeting`/`summary` (nitpick round: pulse's
 * own `greeting` string is never rendered anymore — see `greeting.ts`'s
 * own header comment — and `summary` was always empty on a genuinely
 * empty briefing anyway, since the relay's own "nothing new" message
 * lived entirely in `greeting`). `WhatsNew` (`briefing-spine.tsx`) now
 * says "nothing new" itself, honestly, whenever it has nothing to show —
 * not routed through this state at all.
 */

import type { Result } from '@emdash/shared';
import type { RigAskSource, RigPulseBriefing, RigPulseError } from '@shared/rig/pulse';

export type PulseSectionState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; briefing: RigPulseBriefing; cached: boolean };

/**
 * Whether Home should even attempt to show a pulse section at all — signed
 * out and "solo" (no relay bindings yet, purely local rigs) both render
 * nothing here, no teaser chrome (Dylan's call): the relay's own "no rigs
 * yet" briefing text is honest for someone with zero bindings ANYWHERE, but
 * wrong for someone with local-only rigs who simply hasn't synced any of
 * them — so this gates on a REAL relay binding existing, not just being
 * signed in.
 */
export function shouldShowPulseSection(
  signedIn: boolean,
  workspaces: { status: 'ok'; bindingCount: number } | { status: 'skipped' | 'loading' | 'unreachable' }
): boolean {
  return signedIn && workspaces.status === 'ok' && workspaces.bindingCount > 0;
}

/**
 * A transport/non-2xx failure — genuinely can't reach or trust the relay
 * right now. Mirrors `home-sections.ts`'s own `relayUnreachable` health
 * message: a fixed "offline · ..." line (design-system precedent, not this
 * error's own raw relay text) rather than surfacing whatever the relay's
 * error body happened to say. `notSignedIn`/`untrustedRelay`/`unavailable`
 * are specific enough on their own and keep their real message.
 */
function isOfflineKind(kind: RigPulseError['kind']): boolean {
  return kind === 'relay';
}

export function derivePulseSectionState(query: {
  isLoading: boolean;
  data: Result<{ briefing: RigPulseBriefing; cached: boolean }, RigPulseError> | undefined;
}): PulseSectionState {
  if (query.isLoading || !query.data) return { kind: 'loading' };

  if (!query.data.success) {
    const error = query.data.error;
    return {
      kind: 'error',
      message: isOfflineKind(error.kind) ? 'offline · pulse unavailable right now' : error.message,
    };
  }

  const { briefing, cached } = query.data.data;
  const hasContent =
    briefing.pickBackUp.length > 0 || briefing.perRig.length > 0 || briefing.perPerson.length > 0;
  if (!hasContent) {
    return { kind: 'empty' };
  }
  return { kind: 'data', briefing, cached };
}

// ── HOME RESTRUCTURE — WHAT'S NEW's fresh/older split ───────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** WHAT'S NEW shows at most this many items expanded by default; the rest sit behind "+ N older". */
const FRESH_SHOWN_CAP = 3;

/** An unparseable `at` is honestly not "fresh" — never assumed recent on bad data. */
export function isFreshPickBackUp(at: string, now: number): boolean {
  const ts = Date.parse(at);
  if (Number.isNaN(ts)) return false;
  return now - ts <= SEVEN_DAYS_MS;
}

/**
 * WHAT'S NEW's own split: up to `FRESH_SHOWN_CAP` items within the last 7
 * days show by default (`shown`, most-recent-first); everything else —
 * older-than-7d items AND any fresh overflow past the cap — sits behind
 * the "+ N older" expander (`older`, same recency order, so expanding
 * never re-shuffles what's already visible above it).
 */
export function splitPickBackUp<T extends { at: string }>(
  items: readonly T[],
  now: number
): { shown: T[]; older: T[] } {
  const sorted = [...items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const fresh = sorted.filter((i) => isFreshPickBackUp(i.at, now));
  const stale = sorted.filter((i) => !isFreshPickBackUp(i.at, now));
  return { shown: fresh.slice(0, FRESH_SHOWN_CAP), older: [...fresh.slice(FRESH_SHOWN_CAP), ...stale] };
}

// ── Auto-refresh round — kill the Refresh button ────────────────────────────

/**
 * ~3h — mirrors the relay's own `pulse_cache` TTL (`main/rig/pulse.ts`'s own
 * header comment: "cached server-side per user, ~3h TTL or `?refresh=1`").
 * The point past which a cached briefing is old enough that the client
 * should force a real regeneration (`refresh: true`) rather than trust
 * another plain fetch to happen to return something newer — a plain refetch
 * (window focus, the slow interval) can still hand back a briefing the relay
 * itself hasn't regenerated in a while, if nobody's been active.
 */
export const PULSE_STALE_MS = 3 * 60 * 60 * 1000;

/**
 * An unparseable/missing `generatedAt` (the relay didn't send one, or a
 * malformed value) is honestly not "known fresh" — treated as stale so a
 * broken timestamp never masks genuinely old content sitting behind it.
 */
export function isPulseStale(generatedAt: string, now: number): boolean {
  const ts = Date.parse(generatedAt);
  if (Number.isNaN(ts)) return true;
  return now - ts > PULSE_STALE_MS;
}

// ── Ask-answer round 2 — Dylan: "I don't understand what it maps to" ───────
//
// Investigated in `~/Code/tap`: an INTENT (`docs/context-layer-design-doc.md`
// §3.1) is one work session — an agent session or a human work bout — on a
// rig, auto-captured (nobody writes it by hand): a `title` (the task, e.g.
// "Refactor auth token refresh") and a `status` ('open'/'closed'/'abandoned').
// It's the SAME thing WHAT'S NEW's pick-back-up items already are — just
// cited here as evidence instead of surfaced as an open item. A MESSAGE
// (`binding_messages`) is a post in the rig's team channel — this app has NO
// surface anywhere to browse that channel, so a bare message id has nowhere
// to go and no context (author, thread) to make it explicable either;
// dropped from the UI entirely below rather than shown as an inert citation
// (recommendation, not silently applied — see the PR/report).
//
// TWO gaps confirmed against the wire shape, not assumed:
//   1. `RigAskSource` carries NO rig name — only `bindingId`. Resolved
//      client-side (`rigNameOf` below), from data `BriefingSpine` already
//      has (`localRigs` + the SAME briefing's own `pickBackUp`/`perRig`).
//      A binding genuinely outside all of those degrades to `rigName: null`
//      — never a guessed name.
//   2. `RigAskSource` carries NO intent `status` at all (neither does
//      `RigPulsePickBackUp`, WHAT'S NEW's own item — this app has never
//      received it from the relay). The open/closed status-as-icon idea in
//      the brief isn't achievable honestly today; every intent row gets ONE
//      neutral, non-status-implying icon instead of a fabricated one.

/** One row in the (collapsed-by-default) Ask-sources list — `'message'` sources never reach this shape, filtered out in `deriveAskSourceItems`. */
export type AskSourceListItem = {
  ref: string;
  kind: 'intent' | 'rig';
  /** The intent's title, or — for a `'rig'` source — the rig's own name (the citation IS the rig itself). */
  title: string;
  bindingId: string;
  /** Resolved via `rigNameOf`; `null` when the binding is genuinely unknown to any data this component already has. */
  rigName: string | null;
};

export function deriveAskSourceItems(
  sources: readonly RigAskSource[],
  rigNameOf: (bindingId: string) => string | null
): AskSourceListItem[] {
  return sources
    .filter((s): s is RigAskSource & { kind: 'intent' | 'rig' } => s.kind !== 'message')
    .map((s) => ({
      ref: s.ref,
      kind: s.kind,
      title: s.label,
      bindingId: s.bindingId,
      rigName: s.kind === 'rig' ? s.label : rigNameOf(s.bindingId),
    }));
}

/**
 * "Answered from 5 intents in rig-bike" / "...across 3 rigs" — the one
 * collapsed summary line. Groups by `bindingId` (always defined, unlike
 * `rigName`) so the rig COUNT is honest even when a name failed to
 * resolve; only names a single rig when there's exactly one AND it
 * resolved — never "in null" or "in undefined." The noun degrades from
 * "intents" to the generic "references" the moment the set isn't 100%
 * intents (a bare `'rig'` citation isn't a unit of work, so calling it an
 * "intent" would overclaim).
 */
export function summarizeAskSources(items: readonly AskSourceListItem[]): string {
  if (items.length === 0) return '';
  const allIntents = items.every((item) => item.kind === 'intent');
  const noun = allIntents
    ? items.length === 1
      ? 'intent'
      : 'intents'
    : items.length === 1
      ? 'reference'
      : 'references';
  const uniqueBindingIds = [...new Set(items.map((item) => item.bindingId))];
  const where =
    uniqueBindingIds.length === 1
      ? items[0]?.rigName
        ? ` in ${items[0].rigName}`
        : ''
      : ` across ${uniqueBindingIds.length} rigs`;
  return `Answered from ${items.length} ${noun}${where}`;
}

/**
 * The relay's own message for a failed Ask (`Could not ask about your rigs
 * (relay: rate_limited).`, etc.) is always shown — this only ADDS a
 * clearer line on top of it for the one case worth explaining: a 429.
 * Verified against `tap`'s own rate limiter (`packages/relay/src/routes/
 * account.ts`): `/v1/me/ask` is capped at exactly 40 requests/hour per
 * user (`rateLimit({ windowMs: 60 * 60_000, max: 40, ... })`), returning
 * `429 { error: "rate_limited" }` — the number here is a verified fact,
 * not a guess. Keyed on `status` (an HTTP semantic, stable even if the
 * relay's own error code string ever changes) rather than the code.
 */
export function askErrorMessage(error: RigPulseError): string {
  if (error.kind === 'relay' && error.status === 429) {
    return "You've reached the Ask limit for this hour (40 questions) — try again later.";
  }
  return error.message;
}
