// Turns a recorded first run (RIG_ORCH_RECORD=<file> in a dev build) into the Read step's
// fixture: same timings and shape, every id, ref and outcome line made up. Dev only:
//   node scrub-recording.mjs <recording.jsonl> first-run.json
// Then read the fixture through before committing it: nothing real may be left.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , input, output] = process.argv;
const events = readFileSync(input, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// Invented outcomes, by kind, in order (the prototype's people and tickets).
const OUTCOMES = {
  handled: ['Payout delay: Sam resolved it Tuesday', 'AWS invoice: you forwarded it last month', 'LAR-88: the fix merged yesterday in #207', 'Office move: Léa sorted the badges'],
  not_yours: ['5 Dependabot PRs: the platform team merges these', 'Checkout copy (LAR-74) is Priya’s, and she’s on it', 'Design review notes: an FYI for the whole team'],
  for_you: ['Tom asked for your review of #212 two days ago', 'Priya asked if you can join Thursday’s pilot review', 'LAR-91: checkout timeout, High, nobody on it', 'Léa asked for the SOC 2 evidence list', 'Sam is waiting on a go for the staging deploy'],
};
const used = { handled: 0, not_yours: 0, for_you: 0 };
const ids = new Map();
const idOf = (id) => {
  if (id.startsWith('step:')) return id;
  if (!ids.has(id)) ids.set(id, `${id.startsWith('outcome:') ? 'outcome:' : ''}t${ids.size + 1}`);
  return ids.get(id);
};
const refs = new Map();
const refOf = (ref) => {
  if (!refs.has(ref)) refs.set(ref, `sit_demo_${refs.size + 1}`);
  return refs.get(ref);
};
const outcomeText = new Map();
// Lookups keep their generic words; anything naming a real thing is replaced.
const label = (l) => {
  if (l.status in OUTCOMES) {
    if (!outcomeText.has(l.id)) {
      const list = OUTCOMES[l.status];
      outcomeText.set(l.id, list[used[l.status]++ % list.length]);
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
const out = events.map((e) => {
  const base = { ...e, run: 'run_demo' };
  if (e.kind === 'line') {
    const { ref, ...line } = e.line;
    return { ...base, line: { ...line, id: idOf(e.line.id), label: label(e.line), ...(ref ? { ref: refOf(ref) } : {}) } };
  }
  if (e.kind === 'card') return { ...base, ref: refOf(e.ref) };
  if (e.kind === 'end' && e.error) return { ...base, error: 'Rig stopped reading.' };
  return base;
});
writeFileSync(output, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${out.length} events, ${ids.size} lines, ${refs.size} refs`);
