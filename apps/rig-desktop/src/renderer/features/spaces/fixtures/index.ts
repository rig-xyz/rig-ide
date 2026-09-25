/**
 * Spaces (lane 2) fixtures — real agent session events exported from the
 * `tap-spike-sessions` spike database (`experiment/spaces-session-log`),
 * not synthesized. Export steps, for reproducing this later:
 *
 *   1. `/usr/local/bin/pg_ctl -D <repo>/tap-spike-sessions/.spike/pg-utf8
 *      -o "-p 55462 -k /tmp" start`
 *   2. `psql -h /tmp -p 55462 -U tap -d tap_dev` — dumped `session_runs` and
 *      `session_events` for the 6 runs under `.spike/runs/<name>/summary.json`'s
 *      `runId` (three real ACP runs: Run A, Run B, Run B2; three
 *      synthetic-generator runs: two "worst-case tool output" writes and one
 *      more) as JSON via `row_to_json`/`json_agg`.
 *   3. `pg_ctl -D <repo>/tap-spike-sessions/.spike/pg-utf8 stop`
 *   4. Trimmed with a one-off script: `available_commands_update` payloads
 *      cut to their first 6 commands, and `tool_call`/`tool_call_update`
 *      diff blocks whose `oldText`/`newText` exceeded ~2.4KB truncated to a
 *      head+tail snippet — both marked `truncated: true` with an
 *      `originalBytes` count, per `SessionEvent` in `../types.ts`. Every
 *      other field is verbatim from the database.
 *
 * `session-runs.json` is the raw `session_runs` rows (no `owner` — that's a
 * room-feed concept, not a database one; `room-feed.ts` assigns each run to
 * a story character). `session-events/<key>.json` are the matching
 * `session_events` rows, seq-ordered, already the `SessionEvent` shape.
 */

import type { AgentKind, SessionEvent, SessionStatus } from '../types';
import runA from './session-events/run-a-claude.json';
import runB from './session-events/run-b-codex.json';
import runB2 from './session-events/run-b2-codex-planned.json';
import runC from './session-events/run-c-claude-bigoutput.json';
import runCCodex from './session-events/run-c-codex-bigoutput.json';
import runC2 from './session-events/run-c2-claude-bigoutput.json';
import sessionRunsRaw from './session-runs.json';

export type FixtureRunKey =
  | 'run-a-claude'
  | 'run-b-codex'
  | 'run-b2-codex-planned'
  | 'run-c-claude-bigoutput'
  | 'run-c-codex-bigoutput'
  | 'run-c2-claude-bigoutput';

export interface FixtureRun {
  id: string;
  key: FixtureRunKey;
  agent: AgentKind;
  model: string | null;
  title: string;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
}

export const FIXTURE_RUNS: FixtureRun[] = sessionRunsRaw as FixtureRun[];

export const FIXTURE_EVENTS: Record<FixtureRunKey, SessionEvent[]> = {
  'run-a-claude': runA as SessionEvent[],
  'run-b-codex': runB as SessionEvent[],
  'run-b2-codex-planned': runB2 as SessionEvent[],
  'run-c-claude-bigoutput': runC as SessionEvent[],
  'run-c-codex-bigoutput': runCCodex as SessionEvent[],
  'run-c2-claude-bigoutput': runC2 as SessionEvent[],
};

export function fixtureRun(key: FixtureRunKey): FixtureRun {
  const run = FIXTURE_RUNS.find((r) => r.key === key);
  if (!run) throw new Error(`unknown fixture run: ${key}`);
  return run;
}
