/**
 * The Following tab's model (following-view.tsx): the situations Rig follows
 * for the person, as the relay lists them, grouped by the topics Claude gives
 * them.
 */

export type Followed = { ref: string; title: string; topic: string | null; line: string; people: string[]; at: string };
export type Run = { ref: string; title: string; at: string; ended: string | null; read: { source: string; until: string }[]; changed: number };

export const NO_TOPIC = 'No topic yet';

/** A topic's color, the same for its name everywhere. */
export function hueOf(topic: string): number {
  let h = 0;
  for (const ch of topic) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 8) + 1;
}

/** Topics with the most recent activity first; the untopiced last. */
export function groupByTopic(rows: readonly Followed[]): { topic: string; rows: Followed[] }[] {
  const groups = new Map<string, Followed[]>();
  for (const r of rows) {
    const key = r.topic?.trim() || NO_TOPIC;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const latest = (rs: Followed[]) => Math.max(...rs.map((r) => Date.parse(r.at) || 0));
  return [...groups.entries()]
    .map(([topic, rs]) => ({ topic, rows: rs }))
    .sort((a, b) => (a.topic === NO_TOPIC ? 1 : b.topic === NO_TOPIC ? -1 : latest(b.rows) - latest(a.rows)));
}
