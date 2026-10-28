import { knownTool, toolKey, type FirstRunConnector, type KnownTool } from '@shared/rig/first-run';

/**
 * Connect's switches as the orchestrator's sources (`main/rig/orch/sources.ts`):
 * on is an unpaused source for the tool, off a paused one. The packet reads
 * only unpaused sources, and falls back to Slack, Linear and GitHub when there
 * are none, so Catch me up writes every tool that's on, not just the ones the
 * person flipped. A tool's choice is kept under `toolKey`, so a source named
 * "Calendar" and Claude's "Google Calendar" are the same switch.
 */

/** What to watch in a known tool; any other is read for what waits on the person there. */
const WHAT: Record<KnownTool, string> = {
  slack: 'your DMs and the channels you are in',
  linear: 'issues you created, own or are mentioned in',
  github: 'pull requests and issues that wait on you, through rig_github',
  gmail: 'threads in your inbox that wait on your reply',
  calendar: 'your meetings today and tomorrow',
  notion: 'pages that mention you or were shared with you',
  granola: 'your meeting notes and the follow-ups in them',
};
const WHAT_ELSE = 'what changed that involves you, and what waits on you';

/** A tool as a source: the connector name Claude lists it under, and what to watch. */
export function sourceFor(connector: FirstRunConnector): { connector: string; what: string } {
  const known = knownTool(connector);
  return { connector, what: known ? WHAT[known] : WHAT_ELSE };
}

export type SourceRow = { ref: string; connector: string; paused: boolean };

/** Each tool's choice, by `toolKey`: true watched, false left out, absent when it has no source. */
export type Watching = Partial<Record<string, boolean>>;

function isFor(row: SourceRow, connector: FirstRunConnector): boolean {
  return toolKey(row.connector) === toolKey(connector);
}

/** Which tools have a source: watched when any of its sources runs, left out when all are paused. */
export function watchingFrom(rows: readonly SourceRow[]): Watching {
  const out: Watching = {};
  for (const row of rows) {
    const key = toolKey(row.connector);
    out[key] = out[key] === true || !row.paused;
  }
  return out;
}

/** A tool's choice, as kept. */
export function watched(watching: Watching, connector: FirstRunConnector): boolean | undefined {
  return watching[toolKey(connector)];
}

/** `watching` with one tool's choice set. */
export function withWatched(watching: Watching, connector: FirstRunConnector, on: boolean): Watching {
  return { ...watching, [toolKey(connector)]: on };
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
    if (mine.length === 0) return { add: sourceFor(connector), pause: [] };
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

/** The tools a run reads when no source is set up (the packet's defaults). */
export const DEFAULT_READS: readonly KnownTool[] = ['slack', 'linear', 'github'];

/**
 * Whether Rig reads a tool now, for someone it already reads for: a running
 * source for it, or (with no sources set up) one of the defaults.
 */
export function readsNow(watching: Watching, connector: FirstRunConnector): boolean {
  return Object.keys(watching).length > 0
    ? watched(watching, connector) === true
    : (DEFAULT_READS as readonly string[]).includes(toolKey(connector));
}

/** What Rig reads now as switches: the sources as they are, or the defaults when there are none. */
export function readingNow(watching: Watching): Watching {
  return Object.keys(watching).length > 0
    ? watching
    : Object.fromEntries(DEFAULT_READS.map((c) => [c, true]));
}
