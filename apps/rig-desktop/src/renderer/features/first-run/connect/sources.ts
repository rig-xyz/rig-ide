import type { FirstRunConnector } from '@shared/rig/first-run';

/**
 * Connect's switches as the orchestrator's sources (`main/rig/orch/sources.ts`):
 * on is an unpaused source for the tool, off a paused one. The packet reads
 * only unpaused sources, and falls back to Slack, Linear and GitHub when there
 * are none, so Catch me up writes every tool that's on, not just the ones the
 * person flipped.
 */

/** Each tool as a source: the connector name Claude lists it under, and what to watch. */
export const SOURCE_FOR: Record<FirstRunConnector, { connector: string; what: string }> = {
  slack: { connector: 'Slack', what: 'your DMs and the channels you are in' },
  linear: { connector: 'Linear', what: 'issues you created, own or are mentioned in' },
  github: {
    connector: 'GitHub',
    what: 'pull requests and issues that wait on you, through rig_github',
  },
  gmail: { connector: 'Gmail', what: 'threads in your inbox that wait on your reply' },
  calendar: { connector: 'Google Calendar', what: 'your meetings today and tomorrow' },
  notion: { connector: 'Notion', what: 'pages that mention you or were shared with you' },
};

export type SourceRow = { ref: string; connector: string; paused: boolean };

function isFor(row: SourceRow, connector: FirstRunConnector): boolean {
  return row.connector.toLowerCase().includes(connector);
}

/** Which tools have a source: watched when any of its sources runs, left out when all are paused. */
export function watchingFrom(
  rows: readonly SourceRow[]
): Partial<Record<FirstRunConnector, boolean>> {
  const out: Partial<Record<FirstRunConnector, boolean>> = {};
  for (const connector of Object.keys(SOURCE_FOR) as FirstRunConnector[]) {
    const mine = rows.filter((row) => isFor(row, connector));
    if (mine.length > 0) out[connector] = mine.some((row) => !row.paused);
  }
  return out;
}

/**
 * What to write to turn one tool on or off: on resumes its paused sources,
 * or adds one when it has none; off pauses the ones that run. Nothing to do
 * is an empty write.
 */
export function watchWrites(
  rows: readonly SourceRow[],
  connector: FirstRunConnector,
  on: boolean
): { add: { connector: string; what: string } | null; pause: { ref: string; paused: boolean }[] } {
  const mine = rows.filter((row) => isFor(row, connector));
  if (on) {
    if (mine.length === 0) return { add: SOURCE_FOR[connector], pause: [] };
    return {
      add: null,
      pause: mine.filter((row) => row.paused).map((row) => ({ ref: row.ref, paused: false })),
    };
  }
  return {
    add: null,
    pause: mine.filter((row) => !row.paused).map((row) => ({ ref: row.ref, paused: true })),
  };
}
