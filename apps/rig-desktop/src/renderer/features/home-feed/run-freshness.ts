import { runReadNothing } from '@shared/rig/orch-progress';

/** A background run's row, as `rpc.rig.orch.query({ kind: 'runs' })` lists it, newest first. */
export type RunRow = {
  ref: string;
  /** The run note's summary. */
  title: string;
  at: string;
  ended: string | null;
  read: { source: string; until: string }[];
  changed: number;
};

/**
 * What the Feed's header can honestly say about Rig's last check:
 * - `never`: no run has ended yet;
 * - `fresh`: the latest run that ended read, with its note (`at` is when it ended);
 * - `failing`: the latest run that ended read nothing (it failed, or ended without
 *   its note): `tried` is when, `why` what it said, and `lastRead` the last real
 *   read, if any of the rows has one.
 *
 * A run that read nothing never counts as a check: its row keeps the old cursors
 * in `read` (so the next run reads from the same place), and before this the
 * header took that for a fresh read ("3m ago" on a Feed two weeks old).
 */
export type Freshness =
  | { kind: 'never' }
  | { kind: 'fresh'; at: number; sources: string[]; changed: number }
  | { kind: 'failing'; tried: number; why: string; lastRead: { at: number; sources: string[] } | null };

const endedAt = (r: RunRow) => Date.parse(r.ended ?? r.at) || 0;
const sourcesOf = (r: RunRow) => r.read.map((x) => x.source).filter(Boolean);

export function feedFreshness(runs: readonly RunRow[]): Freshness {
  const ended = runs.filter((r) => r.ended);
  const latest = ended[0];
  if (!latest) return { kind: 'never' };
  if (!runReadNothing(latest.title)) return { kind: 'fresh', at: endedAt(latest), sources: sourcesOf(latest), changed: latest.changed };
  const read = ended.find((r) => !runReadNothing(r.title));
  return {
    kind: 'failing',
    tried: endedAt(latest),
    why: failureWords(latest.title),
    lastRead: read ? { at: endedAt(read), sources: sourcesOf(read) } : null,
  };
}

/** A failed or note-less run's summary in a few plain words, for a tooltip. */
function failureWords(summary: string): string {
  if (summary.startsWith('The run failed:')) return summary.slice('The run failed:'.length).trim() || 'it failed';
  return 'Claude ended it without reading anything';
}
