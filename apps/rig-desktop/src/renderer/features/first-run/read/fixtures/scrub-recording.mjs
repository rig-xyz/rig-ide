// Turns a recorded first run (RIG_ORCH_RECORD=<file> in a dev build) into the Read step's
// fixture: same timings and shape, every id, ref and outcome line made up. Dev only:
//   node scrub-recording.mjs <recording.jsonl> first-run.json
// Then read the fixture through before committing it: nothing real may be left.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , input, output] = process.argv;
const events = readFileSync(input, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// Invented outcomes, by connector and kind (the prototype's people and tickets), so each made-up
// line still reads like its connector: a Slack line is a message, a Linear one a ticket.
const OUTCOMES = {
  slack: {
    handled: ['Payout delay: Sam resolved it Tuesday in #incidents', 'Office badges: Léa sorted them in #ops'],
    not_yours: ['Design review notes in #product: an FYI for the whole team', '#ops snapshot link: Priya is collecting feedback'],
    for_you: ['Priya asked if you can join Thursday’s pilot review', 'Sam is waiting on a go for the staging deploy', 'Tom asked in #eng who owns the rate limits'],
  },
  linear: {
    handled: ['LAR-88: the checkout copy fix merged yesterday'],
    not_yours: ['LAR-74: checkout copy is Priya’s, and she’s on it'],
    for_you: ['LAR-91: checkout timeout, High, nobody on it', 'LAR-95: the export fails for large teams'],
  },
  github: {
    handled: ['#207: you approved it Monday'],
    not_yours: ['5 Dependabot PRs: the platform team merges these'],
    for_you: ['Tom asked for your review of #212 two days ago'],
  },
  gmail: {
    handled: ['AWS invoice: you forwarded it last month'],
    not_yours: ['Newsletter from the design tool: nothing to do'],
    for_you: ['Léa asked for the SOC 2 evidence list'],
  },
  other: {
    handled: ['The pilot plan: Priya updated it this morning'],
    not_yours: ['Team offsite poll: Sam is running it'],
    for_you: ['Thursday 14:00 to 16:00 is free for the pilot review'],
  },
};
/** A made-up ref shaped like the connector's own, so the line keeps its connector. */
const FAKE_REF = { slack: (n) => `msg:slack:CDEMO${n}:1`, linear: (n) => `item:LAR-${90 + n}`, github: (n) => `github:acme/api#${210 + n}`, gmail: (n) => `msg:gmail:demo${n}` };
const used = {};
const ids = new Map();
const idOf = (id) => {
  if (id.startsWith('step:')) return id;
  if (!ids.has(id)) ids.set(id, `${id.startsWith('outcome:') ? 'outcome:' : ''}t${ids.size + 1}`);
  return ids.get(id);
};
const refs = new Map();
const refOf = (ref, connector) => {
  if (!refs.has(ref)) refs.set(ref, FAKE_REF[connector]?.(refs.size + 1) ?? `sit_demo_${refs.size + 1}`);
  return refs.get(ref);
};
const outcomeText = new Map();
// Lookups keep their generic words; anything naming a real thing is replaced.
const label = (l) => {
  if (['handled', 'not_yours', 'for_you'].includes(l.status)) {
    if (!outcomeText.has(l.id)) {
      const by = OUTCOMES[l.connector] ?? OUTCOMES.other;
      const key = `${l.connector}:${l.status}`;
      used[key] = (used[key] ?? 0) + 1;
      const list = by[l.status];
      outcomeText.set(l.id, list[(used[key] - 1) % list.length]);
    }
    return outcomeText.get(l.id);
  }
  return l.label
    .replace(/#\d+/g, '#212')
    .replace(/Opening [A-Z]+-\d+/, 'Opening LAR-91')
    .replace(/Reading the comments on [A-Z]+-\d+/, 'Reading the comments on LAR-91')
    .replace(/Searching Slack for ".*"/, 'Searching Slack for "pilot review"')
    .replace(/Reading #[\w-]+/, 'Reading #eng')
    .replace(/a thread in #[\w-]+/, 'a thread in #product');
};
// A recording from before the start event carried the run's budget: fill it in from its planned passes.
const start = events.find((e) => e.kind === 'start');
if (start && start.lookups === undefined) {
  start.lookups = events.filter((e) => e.kind === 'pass' && e.pass <= start.passes).reduce((n, e) => n + e.lookups, 0);
}
const out = events.map((e) => {
  const base = { ...e, run: 'run_demo' };
  if (e.kind === 'line') {
    const { ref, ...line } = e.line;
    return { ...base, line: { ...line, id: idOf(e.line.id), label: label(e.line), ...(ref ? { ref: refOf(ref, e.line.connector) } : {}) } };
  }
  if (e.kind === 'card') return { ...base, ref: refOf(e.ref, null) };
  if (e.kind === 'end' && e.error) return { ...base, error: 'Rig stopped reading.' };
  return base;
});
writeFileSync(output, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${out.length} events, ${ids.size} lines, ${refs.size} refs`);
