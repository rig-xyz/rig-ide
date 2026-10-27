import { SOURCES } from './mock';
import type { SourceConnector } from './model';
import { needsYouPhrase } from './say';

/**
 * The seam between Home's chat and whatever answers it. Home only knows this
 * interface: today `scriptedOrchestrator` answers from a few patterns, like the
 * prototype; the real orchestrator agent (`docs/orchestrator-design.md` §10)
 * plugs in here by returning the same blocks.
 */

/** A run of a message: plain words, bold words, or a chip that opens something. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'session'; sessionId: string; label: string }
  | { kind: 'source'; connector: SourceConnector };

export interface BriefRow {
  label: string;
  value: string;
  /** Shows the source's logo before the value. */
  connector?: SourceConnector;
}

/** What a reply can hold, rendered in order under Rig's name. */
export type ReplyBlock =
  | { kind: 'text'; runs: Inline[] }
  /** Every session that's running or waiting, live from the rail. */
  | { kind: 'status' }
  /** A drafted brief with a Start button. */
  | { kind: 'brief'; title: string; rows: BriefRow[]; start: { spaceId: string; name: string } }
  /** A routine Rig would save and run on a schedule. */
  | { kind: 'routine'; title: string; rows: BriefRow[]; name: string };

export interface OrchestratorContext {
  firstName: string;
  needsYou: number;
  upNext: number;
  /** The space Rig suggests when the user doesn't name one. */
  defaultSpaceId: string;
  spaceIds: readonly string[];
}

export interface HomeOrchestrator {
  greeting(ctx: OrchestratorContext): ReplyBlock[];
  respond(text: string, ctx: OrchestratorContext): Promise<ReplyBlock[]>;
}

const t = (text: string): Inline => ({ kind: 'text', text });
const b = (text: string): Inline => ({ kind: 'bold', text });

function capitalize(text: string): string {
  return text.replace(/^\w/, (c) => c.toUpperCase());
}

/** Shortens a goal to a rail-sized session name. */
export function sessionNameFromGoal(goal: string): string {
  const clean = capitalize(goal.trim());
  if (!clean) return 'New session';
  return clean.length > 42 ? `${clean.slice(0, 40).replace(/\s\S*$/, '')}…` : clean;
}

function pickSpace(text: string, ctx: OrchestratorContext): string {
  const has = (id: string) => ctx.spaceIds.includes(id);
  if (/ops|usage|metric/i.test(text) && has('rig-ops')) return 'rig-ops';
  if (/deck|manifesto|investor/i.test(text) && has('rig-marketing')) return 'rig-marketing';
  return ctx.defaultSpaceId;
}

/** Answers the four things the preview understands, the way the prototype does. */
export const scriptedOrchestrator: HomeOrchestrator = {
  greeting(ctx) {
    return [
      {
        kind: 'text',
        runs: [
          t(
            `${needsYouPhrase(ctx.needsYou)} and ${ctx.upNext} ${ctx.upNext === 1 ? 'is' : 'are'} up next, on the right. Two sessions ran overnight; `
          ),
          { kind: 'session', sessionId: 's-stale', label: 'the stale cleanup' },
          t(' finished. Ask me for status, or tell me what to start.'),
        ],
      },
    ];
  },

  async respond(text, ctx) {
    const low = text.trim().toLowerCase();
    if (/status|going on|update/.test(low)) {
      return [
        {
          kind: 'text',
          runs: [t("Here's everything running or waiting. Click one to see its context here.")],
        },
        { kind: 'status' },
      ];
    }
    if (/came in|inbox|new today/.test(low)) {
      // The demo's own five; Calendar and Notion came later, for the first run.
      const connectors = (Object.keys(SOURCES) as SourceConnector[]).filter(
        (c) => c !== 'calendar' && c !== 'notion'
      );
      const runs: Inline[] = [t('24 items since 8:00 from ')];
      connectors.forEach((c, i) => {
        runs.push({ kind: 'source', connector: c }, t(` ${SOURCES[c].name}`));
        if (i < connectors.length - 1) runs.push(t(', '));
      });
      runs.push(t('. I promoted 3 to your Feed and held back 3 topics.'));
      return [{ kind: 'text', runs }];
    }
    if (/^every|weekly|daily/.test(low)) {
      const name = capitalize(text.trim().replace(/^every\s+\w+,?\s*/i, ''));
      const when = text.match(/every\s+\w+/i)?.[0] ?? 'Every week';
      return [
        {
          kind: 'text',
          runs: [
            t(
              'I can make that a routine: a file Rig runs on schedule, which you can edit or remove.'
            ),
          ],
        },
        {
          kind: 'routine',
          title: `Routine · ${name}`,
          name,
          rows: [
            { label: 'When', value: `${capitalize(when)}, 9:00` },
            { label: 'Source', value: 'Linear · Ulys', connector: 'linear' },
            {
              label: 'Does',
              value:
                'A background session closes Earn tickets untouched for 30 days, each with a reason; asks before anything else',
            },
            { label: 'File', value: '.rig/routines/clear-stale-earn.md' },
          ],
        },
      ];
    }
    if (/^start|session|clear|triage|draft|investigate|look into/.test(low)) {
      const goal = capitalize(text.trim().replace(/^start (a )?session (to|for)\s*/i, ''));
      const name = sessionNameFromGoal(goal);
      const spaceId = pickSpace(text, ctx);
      return [
        { kind: 'text', runs: [t('Drafted a brief. Edit anything, then start.')] },
        {
          kind: 'brief',
          title: name,
          start: { spaceId, name },
          rows: [
            { label: 'Goal', value: goal || 'Describe the goal' },
            { label: 'Runs in', value: `#${spaceId}` },
            { label: 'Claude uses', value: 'Your connectors · asks before writing' },
          ],
        },
      ];
    }
    return [
      {
        kind: 'text',
        runs: [
          t('In this preview I understand: '),
          b('status update'),
          t(', '),
          b('start a session to …'),
          t(', '),
          b('every Monday …'),
          t(' and '),
          b('what came in today?'),
        ],
      },
    ];
  },
};
