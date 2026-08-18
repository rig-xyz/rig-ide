import { describe, expect, it } from 'vitest';
import {
  askErrorMessage,
  deriveAskSourceItems,
  derivePulseSectionState,
  isFreshPickBackUp,
  isPulseStale,
  PULSE_STALE_MS,
  shouldShowPulseSection,
  splitPickBackUp,
  summarizeAskSources,
} from './pulse-state';

const BRIEFING_WITH_CONTENT = {
  greeting: 'Good morning, Dylan.',
  summary: 'Three open intents.',
  pickBackUp: [
    { bindingId: 'bnd_1', rigName: 'rig-one', intentId: 'int_1', title: 'Fix it', why: 'Blocking release.', at: '2026-08-15T00:00:00Z' },
  ],
  perRig: [],
  perPerson: [],
  generatedAt: '2026-08-15T00:00:00Z',
  degraded: false,
};

const EMPTY_BRIEFING = {
  greeting: 'Good morning — nothing new across your rigs yet.',
  summary: '',
  pickBackUp: [],
  perRig: [],
  perPerson: [],
  generatedAt: '2026-08-15T00:00:00Z',
  degraded: false,
};

describe('shouldShowPulseSection', () => {
  it('signed out — absent regardless of bindings', () => {
    expect(shouldShowPulseSection(false, { status: 'ok', bindingCount: 5 })).toBe(false);
  });

  it('signed in but zero relay bindings ("solo") — absent, no teaser chrome', () => {
    expect(shouldShowPulseSection(true, { status: 'ok', bindingCount: 0 })).toBe(false);
  });

  it('workspaces still loading/unreachable/skipped — absent (nothing confirmed yet)', () => {
    expect(shouldShowPulseSection(true, { status: 'loading' })).toBe(false);
    expect(shouldShowPulseSection(true, { status: 'unreachable' })).toBe(false);
    expect(shouldShowPulseSection(true, { status: 'skipped' })).toBe(false);
  });

  it('signed in with at least one real relay binding — shown', () => {
    expect(shouldShowPulseSection(true, { status: 'ok', bindingCount: 1 })).toBe(true);
  });
});

describe('derivePulseSectionState', () => {
  it('loading: no data yet', () => {
    expect(derivePulseSectionState({ isLoading: true, data: undefined })).toEqual({ kind: 'loading' });
  });

  it('loading: isLoading false but data has not arrived (React Query\'s own transient state)', () => {
    expect(derivePulseSectionState({ isLoading: false, data: undefined })).toEqual({ kind: 'loading' });
  });

  it('data: a briefing with real content to narrate', () => {
    expect(
      derivePulseSectionState({
        isLoading: false,
        data: { success: true, data: { briefing: BRIEFING_WITH_CONTENT, cached: true } },
      })
    ).toEqual({ kind: 'data', briefing: BRIEFING_WITH_CONTENT, cached: true });
  });

  it('empty: a real 200 briefing with nothing to narrate — a bare kind, no greeting/summary (nitpick round: pulse\'s greeting string is never rendered; the UI states "nothing new" itself)', () => {
    expect(
      derivePulseSectionState({
        isLoading: false,
        data: { success: true, data: { briefing: EMPTY_BRIEFING, cached: false } },
      })
    ).toEqual({ kind: 'empty' });
  });

  it('data: a degraded (no-LLM-key) briefing is still real data, not an error — Home is never blocked on the relay having a key', () => {
    const degraded = { ...BRIEFING_WITH_CONTENT, degraded: true };
    const state = derivePulseSectionState({
      isLoading: false,
      data: { success: true, data: { briefing: degraded, cached: false } },
    });
    expect(state.kind).toBe('data');
    expect(state.kind === 'data' && state.briefing.degraded).toBe(true);
  });

  it('error: a relay/transport failure gets the fixed offline-chip-style line, not the raw relay error text', () => {
    expect(
      derivePulseSectionState({
        isLoading: false,
        data: { success: false, error: { kind: 'relay', status: 500, message: 'raw relay 500 body text' } },
      })
    ).toEqual({ kind: 'error', message: 'offline · pulse unavailable right now' });
  });

  it('error: notSignedIn keeps its own specific message', () => {
    expect(
      derivePulseSectionState({
        isLoading: false,
        data: { success: false, error: { kind: 'notSignedIn', message: 'Not signed in to Rig.' } },
      })
    ).toEqual({ kind: 'error', message: 'Not signed in to Rig.' });
  });

  it('error: untrustedRelay keeps its own specific message', () => {
    expect(
      derivePulseSectionState({
        isLoading: false,
        data: {
          success: false,
          error: { kind: 'untrustedRelay', host: 'evil.example', message: 'refusing to send your token' },
        },
      })
    ).toEqual({ kind: 'error', message: 'refusing to send your token' });
  });
});

const NOW = Date.parse('2026-08-15T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function atDaysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

describe('isFreshPickBackUp', () => {
  it('within 7 days — fresh', () => {
    expect(isFreshPickBackUp(atDaysAgo(0), NOW)).toBe(true);
    expect(isFreshPickBackUp(atDaysAgo(6.9), NOW)).toBe(true);
  });

  it('older than 7 days — stale', () => {
    expect(isFreshPickBackUp(atDaysAgo(7.1), NOW)).toBe(false);
    expect(isFreshPickBackUp(atDaysAgo(30), NOW)).toBe(false);
  });

  it('an unparseable date is honestly not fresh, never assumed recent', () => {
    expect(isFreshPickBackUp('not-a-date', NOW)).toBe(false);
    expect(isFreshPickBackUp('', NOW)).toBe(false);
  });
});

describe('splitPickBackUp', () => {
  it('few fresh items, none stale — all shown, nothing older', () => {
    const items = [{ id: 'a', at: atDaysAgo(1) }, { id: 'b', at: atDaysAgo(2) }];
    const result = splitPickBackUp(items, NOW);
    expect(result.shown.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.older).toEqual([]);
  });

  it('sorts by recency first — most recent shown first regardless of input order', () => {
    const items = [
      { id: 'old', at: atDaysAgo(3) },
      { id: 'newest', at: atDaysAgo(0) },
      { id: 'mid', at: atDaysAgo(1) },
    ];
    const result = splitPickBackUp(items, NOW);
    expect(result.shown.map((i) => i.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('more than 3 fresh items — caps shown at 3, the rest fall into older (not dropped)', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, at: atDaysAgo(i) }));
    const result = splitPickBackUp(items, NOW);
    expect(result.shown.map((i) => i.id)).toEqual(['f0', 'f1', 'f2']);
    expect(result.older.map((i) => i.id)).toEqual(['f3', 'f4']);
  });

  it('a stale (>7d) item never counts toward the 3 shown, however recent the fresh ones are', () => {
    const items = [{ id: 'fresh', at: atDaysAgo(1) }, { id: 'stale', at: atDaysAgo(30) }];
    const result = splitPickBackUp(items, NOW);
    expect(result.shown.map((i) => i.id)).toEqual(['fresh']);
    expect(result.older.map((i) => i.id)).toEqual(['stale']);
  });

  it('older keeps recency order too — fresh overflow first, then stale, newest of each group first', () => {
    const items = [
      { id: 'fresh1', at: atDaysAgo(0) },
      { id: 'fresh2', at: atDaysAgo(1) },
      { id: 'fresh3', at: atDaysAgo(2) },
      { id: 'fresh4', at: atDaysAgo(3) }, // overflow (4th fresh)
      { id: 'stale1', at: atDaysAgo(10) },
    ];
    const result = splitPickBackUp(items, NOW);
    expect(result.older.map((i) => i.id)).toEqual(['fresh4', 'stale1']);
  });

  it('empty input — nothing shown, nothing older', () => {
    expect(splitPickBackUp([], NOW)).toEqual({ shown: [], older: [] });
  });
});

describe('isPulseStale', () => {
  it('just generated — fresh', () => {
    expect(isPulseStale(new Date(NOW).toISOString(), NOW)).toBe(false);
  });

  it('under the ~3h TTL — still fresh, right up to the edge', () => {
    expect(isPulseStale(new Date(NOW - (PULSE_STALE_MS - 1)).toISOString(), NOW)).toBe(false);
  });

  it('past the ~3h TTL — stale', () => {
    expect(isPulseStale(new Date(NOW - (PULSE_STALE_MS + 1)).toISOString(), NOW)).toBe(true);
    expect(isPulseStale(atDaysAgo(1), NOW)).toBe(true);
  });

  it('an unparseable/missing generatedAt is honestly not "known fresh" — treated as stale', () => {
    expect(isPulseStale('', NOW)).toBe(true);
    expect(isPulseStale('not-a-date', NOW)).toBe(true);
  });
});

describe('deriveAskSourceItems', () => {
  const rigNameOf = (bindingId: string) => (bindingId === 'b1' ? 'rig-bike' : null);

  it('an intent source resolves its rig name via the resolver', () => {
    expect(
      deriveAskSourceItems([{ kind: 'intent', bindingId: 'b1', ref: 'int_1', label: 'Fix the bug' }], rigNameOf)
    ).toEqual([{ ref: 'int_1', kind: 'intent', title: 'Fix the bug', bindingId: 'b1', rigName: 'rig-bike' }]);
  });

  it('a rig source uses its own label as BOTH the title and the rig name — the citation IS the rig', () => {
    expect(
      deriveAskSourceItems([{ kind: 'rig', bindingId: 'b1', ref: 'b1', label: 'rig-bike' }], rigNameOf)
    ).toEqual([{ ref: 'b1', kind: 'rig', title: 'rig-bike', bindingId: 'b1', rigName: 'rig-bike' }]);
  });

  it('a message source is dropped entirely — not rendered, no in-app destination or context to explain it', () => {
    expect(
      deriveAskSourceItems([{ kind: 'message', bindingId: 'b1', ref: 'msg_1', label: 'hey can we...' }], rigNameOf)
    ).toEqual([]);
  });

  it('an unresolvable binding degrades rigName to null, never a guessed name', () => {
    expect(
      deriveAskSourceItems([{ kind: 'intent', bindingId: 'unknown', ref: 'int_2', label: 'Something' }], rigNameOf)
    ).toEqual([{ ref: 'int_2', kind: 'intent', title: 'Something', bindingId: 'unknown', rigName: null }]);
  });

  it('filters and maps a mixed list, preserving order', () => {
    const result = deriveAskSourceItems(
      [
        { kind: 'intent', bindingId: 'b1', ref: 'int_1', label: 'Fix the bug' },
        { kind: 'message', bindingId: 'b1', ref: 'msg_1', label: 'dropped' },
        { kind: 'rig', bindingId: 'b1', ref: 'b1', label: 'rig-bike' },
      ],
      rigNameOf
    );
    expect(result.map((i) => i.ref)).toEqual(['int_1', 'b1']);
  });
});

describe('summarizeAskSources', () => {
  const intent = (ref: string, bindingId: string, rigName: string | null): Parameters<typeof summarizeAskSources>[0][number] => ({
    ref,
    kind: 'intent',
    title: 'title',
    bindingId,
    rigName,
  });

  it('empty — no summary at all', () => {
    expect(summarizeAskSources([])).toBe('');
  });

  it('singular intent, one named rig', () => {
    expect(summarizeAskSources([intent('i1', 'b1', 'rig-bike')])).toBe('Answered from 1 intent in rig-bike');
  });

  it('plural intents, one named rig', () => {
    expect(
      summarizeAskSources([intent('i1', 'b1', 'rig-bike'), intent('i2', 'b1', 'rig-bike'), intent('i3', 'b1', 'rig-bike')])
    ).toBe('Answered from 3 intents in rig-bike');
  });

  it('groups by bindingId across multiple rigs — "across N rigs", not names', () => {
    expect(summarizeAskSources([intent('i1', 'b1', 'rig-bike'), intent('i2', 'b2', 'rig-hike')])).toBe(
      'Answered from 2 intents across 2 rigs'
    );
  });

  it('multiple intents citing the SAME rig still count as one rig, not one per citation', () => {
    expect(
      summarizeAskSources([intent('i1', 'b1', 'rig-bike'), intent('i2', 'b1', 'rig-bike'), intent('i3', 'b2', 'rig-hike')])
    ).toBe('Answered from 3 intents across 2 rigs');
  });

  it('a single rig with an unresolved name omits the "in ..." clause rather than showing null/undefined', () => {
    expect(summarizeAskSources([intent('i1', 'b1', null)])).toBe('Answered from 1 intent');
  });

  it('multiple rigs count honestly by bindingId even when some names are unresolved', () => {
    expect(summarizeAskSources([intent('i1', 'b1', 'rig-bike'), intent('i2', 'b2', null)])).toBe(
      'Answered from 2 intents across 2 rigs'
    );
  });

  it('a mix of intent and rig citations degrades the noun to "references" — a bare rig citation is not a unit of work', () => {
    expect(
      summarizeAskSources([
        intent('i1', 'b1', 'rig-bike'),
        { ref: 'b1', kind: 'rig', title: 'rig-bike', bindingId: 'b1', rigName: 'rig-bike' },
      ])
    ).toBe('Answered from 2 references in rig-bike');
  });

  it('a single rig-only citation is singular "reference"', () => {
    expect(
      summarizeAskSources([{ ref: 'b1', kind: 'rig', title: 'rig-bike', bindingId: 'b1', rigName: 'rig-bike' }])
    ).toBe('Answered from 1 reference in rig-bike');
  });
});

describe('askErrorMessage', () => {
  it('a 429 relay error gets the clearer, verified 40/hour line instead of the raw code', () => {
    expect(
      askErrorMessage({ kind: 'relay', status: 429, message: 'Could not ask about your rigs (relay: rate_limited).' })
    ).toBe("You've reached the Ask limit for this hour (40 questions) — try again later.");
  });

  it('every other relay status keeps the relay\'s own message verbatim', () => {
    expect(
      askErrorMessage({ kind: 'relay', status: 500, message: 'Could not ask about your rigs (relay 500).' })
    ).toBe('Could not ask about your rigs (relay 500).');
    expect(
      askErrorMessage({ kind: 'relay', message: 'Could not ask about your rigs — the relay is unreachable.' })
    ).toBe('Could not ask about your rigs — the relay is unreachable.');
  });

  it('non-relay error kinds keep their own specific message untouched', () => {
    expect(askErrorMessage({ kind: 'notSignedIn', message: 'Not signed in to Rig.' })).toBe('Not signed in to Rig.');
    expect(
      askErrorMessage({ kind: 'unavailable', message: "Ask isn't available on this relay right now." })
    ).toBe("Ask isn't available on this relay right now.");
  });
});
