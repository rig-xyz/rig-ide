/**
 * Search in a space's chat (Cmd-F in the Room): which messages match, and
 * where in their text. Matching here is on what the Room has loaded, as
 * you type: every word of the query somewhere in the text, ignoring case
 * (a query under three characters, or one with no letters or digits, is
 * matched whole). The relay finds the older matches (`RoomSource.search`);
 * its matches are a subset of these rules (each word as the start of a
 * word), so what it returns always highlights.
 *
 * A person's message and a doc comment match on their text; an agent's turn
 * matches on its final answer, never its steps.
 */

import { runCard } from './projection';
import type { RoomMessage, RoomSnapshot, SessionEvent } from './types';

export type SearchPlan = { mode: 'words'; terms: string[] } | { mode: 'substring'; text: string };

/** How a query is matched; null for an empty one. */
export function planSearch(query: string): SearchPlan | null {
  const text = query.trim().toLowerCase();
  if (!text) return null;
  const terms = [...new Set(text.match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (text.length < 3 || terms.length === 0) return { mode: 'substring', text };
  return { mode: 'words', terms };
}

/** Where `plan` matches `text`, as `[start, end)` ranges in order, overlaps merged. */
export function matchRanges(text: string, plan: SearchPlan): Array<[number, number]> {
  const lower = text.toLowerCase();
  const needles = plan.mode === 'words' ? plan.terms : [plan.text];
  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    if (!needle) continue;
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + needle.length)) {
      ranges.push([i, i + needle.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

export function textMatches(text: string, plan: SearchPlan): boolean {
  const lower = text.toLowerCase();
  return plan.mode === 'words' ? plan.terms.every((t) => lower.includes(t)) : lower.includes(plan.text);
}

/** A run's final answer, projected once per log (the same log array is the same answer). */
const answers = new WeakMap<readonly SessionEvent[], string>();

function answerOf(snapshot: Pick<RoomSnapshot, 'sessionEventsByRun' | 'sessionSummaryByRun'>, runId: string): string {
  const events = snapshot.sessionEventsByRun[runId];
  if (!events || events.length === 0) return snapshot.sessionSummaryByRun?.[runId]?.answer ?? '';
  let answer = answers.get(events);
  if (answer === undefined) {
    answer = runCard(snapshot, runId).finalAnswer;
    answers.set(events, answer);
  }
  return answer;
}

/** What a message is searched on: a person's text or a comment, an agent turn's answer; null for anything else. */
export function searchableText(
  message: RoomMessage,
  snapshot: Pick<RoomSnapshot, 'sessionEventsByRun' | 'sessionSummaryByRun'>
): string | null {
  switch (message.meta.kind) {
    case 'text':
    case 'comment_mirror':
      return message.body ?? null;
    case 'session':
      return answerOf(snapshot, message.meta.runId) || null;
    default:
      return null;
  }
}

/** The loaded messages that match, in chat order. */
export function localMatches(
  snapshot: Pick<RoomSnapshot, 'messages' | 'sessionEventsByRun' | 'sessionSummaryByRun'>,
  plan: SearchPlan
): RoomMessage[] {
  return snapshot.messages.filter((m) => {
    if (m.sending) return false;
    const text = searchableText(m, snapshot);
    return text !== null && textMatches(text, plan);
  });
}

/**
 * The matches to show, in chat order: the loaded ones, and the relay's
 * (`remote`, any order). A message in both, or one the Room has loaded
 * since the relay answered, is shown as the Room has it now.
 */
export function mergeMatches(
  local: readonly RoomMessage[],
  remote: readonly RoomMessage[],
  loaded: readonly RoomMessage[]
): RoomMessage[] {
  const byId = new Map<string, RoomMessage>();
  for (const m of remote) byId.set(m.id, m);
  if (remote.length > 0) {
    const loadedById = new Map(loaded.map((m) => [m.id, m]));
    for (const [id, m] of byId) {
      const current = loadedById.get(id);
      if (current && current !== m) byId.set(id, current);
    }
  }
  for (const m of local) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** The bar's words: "12 matches for “pricing”", "30+ …" while the relay has more. */
export function matchCountLabel(count: number, query: string, more: boolean): string {
  const n = more ? `${count}+` : String(count);
  return `${n} ${count === 1 && !more ? 'match' : 'matches'} for “${query.trim()}”`;
}
