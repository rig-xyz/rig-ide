import { isGeneratedSpaceName } from '@shared/rig/space-names';

/**
 * The gardener's plumbing (spike, Rig Alpha). About once an hour per space, and only when
 * something in the space changed, Rig starts one short turn in the space owner's own Claude
 * session. What that turn does is decided by the words of the bundled `rig-gardener` skill; this
 * file only keeps time, decides whether a turn may start at all, and writes down what Rig alone
 * can know (when it started, how it ended, what the space looked like afterwards).
 *
 * Pure: every outside fact comes in through `GardenerDeps`, wired in
 * `spaces/dispatch-controller-instance.ts`.
 */

export const GARDENER_TICK_MS = 60_000;
/** At least this long between two starts in a space. */
export const GARDENER_MIN_GAP_MS = 60 * 60_000;
/** At most this many starts per space in any rolling 24 hours. */
export const GARDENER_MAX_PER_DAY = 6;
/** The owner's session has to have been quiet this long before a look. */
export const GARDENER_QUIET_MS = 10 * 60_000;
/** A quiet space's files are walked at most this often; the walk is the costly part of a tick. */
export const GARDENER_CHECK_EVERY_MS = 10 * 60_000;
export const GARDENER_NOTE_MAX = 1500;
/** What the turn replies when nothing needs a person; Rig keeps that reply out of the Room. */
export const GARDENER_SILENT_REPLY = 'All is well.';
/** The card's first line if a card is ever posted, so it stays short and human. */
export const GARDENER_PROMPT = 'Looking over this space.';

const DAY_MS = 24 * 60 * 60_000;
const FACTS_MAX = 4_000;

export type GardenerRecord = {
  /** Start times in the last 24 h. */
  starts: number[];
  lastStartedMs: number | null;
  lastFinishedMs: number | null;
  lastStatus: 'done' | 'failed' | 'stopped' | 'not_started' | null;
  /** Taken when the last pass ended. */
  fingerprint: string | null;
  /** The last pass's final words, cut to `GARDENER_NOTE_MAX`. */
  lastNote: string | null;
  /** The space's name when a pass that could rename began. */
  nameAtStart: string | null;
  /** The name has changed since; the free rename is never offered again. */
  renameDone: boolean;
};

export type GardenerStore = {
  get(id: string): GardenerRecord | null;
  set(id: string, record: GardenerRecord): void;
};

export type GardenerDeps = {
  enabled: () => boolean;
  me: () => Promise<string | null>;
  /** The owner last used Rig on another Mac. */
  elsewhere: () => boolean;
  spaces: () => Promise<{ bindingId: string; path: string; name: string; role: string }[]>;
  busy: (bindingId: string, userId: string) => boolean;
  lastTurnAt: (bindingId: string, userId: string) => number | null;
  fingerprint: (path: string) => Promise<string | null>;
  facts: (space: { bindingId: string; path: string }) => Promise<{ views: string; doctor: string | null }>;
  run: (spec: {
    bindingId: string;
    userId: string;
    prompt: string;
    context: string;
    mayRename: boolean;
  }) => Promise<{ done: Promise<{ status: string; answer: string }> } | null>;
  store: GardenerStore;
  now: () => number;
};

/** A cheap summary of a space's files: how many, and when the newest changed. */
export function spaceFingerprint(files: { relPath: string; mtimeMs: number }[]): string {
  if (files.length === 0) return '0:0';
  const newest = files.reduce((max, file) => Math.max(max, file.mtimeMs), 0);
  return `${files.length}:${Math.floor(newest)}`;
}

const emptyRecord = (): GardenerRecord => ({
  starts: [],
  lastStartedMs: null,
  lastFinishedMs: null,
  lastStatus: null,
  fingerprint: null,
  lastNote: null,
  nameAtStart: null,
  renameDone: false,
});

/** The pass's final words, or null when there are none worth keeping (nothing, or the silent reply). */
function noteOf(answer: string): string | null {
  const text = answer.trim();
  if (!text) return null;
  if (text.replace(/\.$/, '').toLowerCase() === GARDENER_SILENT_REPLY.replace(/\.$/, '').toLowerCase()) return null;
  return text.slice(0, GARDENER_NOTE_MAX);
}

/** How many other names the turn is given; past this the list stops helping. */
const OTHER_NAMES_MAX = 60;

export function gardenerContext(spec: {
  name: string;
  nameIsRandom: boolean;
  mayRename: boolean;
  /** Names of the person's other spaces, so a new name does not repeat one. */
  otherNames?: readonly string[];
  views: string;
  doctor: string | null;
  lastNote: string | null;
}): string {
  const nameLine =
    `The space is called "${spec.name}".` +
    (spec.nameIsRandom
      ? spec.mayRename
        ? ' That name was picked at random when the space was made; nobody chose it. You may rename it once with rig_space_rename without asking.'
        : ' That name was picked at random, and renaming it now asks your owner first.'
      : ' A person chose that name.');
  const others = [...new Set(spec.otherNames ?? [])].slice(0, OTHER_NAMES_MAX);
  const othersLine =
    spec.mayRename && others.length > 0
      ? `Your owner's other spaces are called: ${others.map((name) => `"${name}"`).join(', ')}. A new name must differ from all of them.`
      : null;
  return [
    "This turn was started by Rig's regular look over the space, not by a person. Nobody is waiting for a reply.",
    'Read the rig-gardener skill at `~/.claude/skills/rig-gardener/SKILL.md` (Codex: `~/.agents/skills/rig-gardener/SKILL.md`) and do what it says, nothing more.',
    `If nothing needs a person, reply with exactly \`${GARDENER_SILENT_REPLY}\` and nothing else. Rig keeps that reply out of the Room.`,
    nameLine,
    ...(othersLine ? [othersLine] : []),
    `What Rig knows about the views here (schedule, last refresh, next refresh), as JSON: ${spec.views}`,
    spec.doctor !== null
      ? `Rig's own check of this space (rig doctor), as JSON: ${spec.doctor}`
      : "Rig's own check of this space could not run this time.",
    spec.lastNote !== null
      ? `Your last look ended with: "${spec.lastNote}"`
      : 'This is your first look at this space.',
  ].join('\n');
}

export function createGardener(deps: GardenerDeps): { tick(): Promise<string | null> } {
  let ticking = false;
  const lastChecked = new Map<string, number>();

  async function tick(): Promise<string | null> {
    if (ticking) return null;
    ticking = true;
    try {
      if (!deps.enabled()) return null;
      const me = await deps.me();
      if (!me) return null;
      if (deps.elsewhere()) return null;
      const spaces = await deps.spaces();
      for (const space of spaces) {
        // Only the owner's app looks over a space: the one rule against duplicate passes.
        if (space.role !== 'owner') continue;
        const now = deps.now();
        let record = deps.store.get(space.bindingId) ?? emptyRecord();
        if (record.nameAtStart !== null && record.nameAtStart !== space.name && !record.renameDone) {
          record = { ...record, renameDone: true };
          deps.store.set(space.bindingId, record);
        }
        const starts = record.starts.filter((at) => now - at < DAY_MS);
        if (record.lastStartedMs !== null && now - record.lastStartedMs < GARDENER_MIN_GAP_MS) continue;
        if (starts.length >= GARDENER_MAX_PER_DAY) continue;
        if (deps.busy(space.bindingId, me)) continue;
        const last = deps.lastTurnAt(space.bindingId, me);
        // No stored turn: nothing has happened in the space yet.
        if (last === null || now - last < GARDENER_QUIET_MS) continue;
        const checked = lastChecked.get(space.bindingId);
        if (checked !== undefined && now - checked < GARDENER_CHECK_EVERY_MS) continue;
        lastChecked.set(space.bindingId, now);
        const before = await deps.fingerprint(space.path);
        if (before === null || before === record.fingerprint) continue;

        const nameIsRandom = isGeneratedSpaceName(space.name);
        const mayRename = nameIsRandom && !record.renameDone;
        record = {
          ...record,
          starts: [...starts, now],
          lastStartedMs: now,
          nameAtStart: mayRename ? space.name : record.nameAtStart,
        };
        deps.store.set(space.bindingId, record);

        const facts = await deps.facts({ bindingId: space.bindingId, path: space.path });
        const context = gardenerContext({
          name: space.name,
          nameIsRandom,
          mayRename,
          otherNames: spaces.filter((other) => other.bindingId !== space.bindingId).map((other) => other.name),
          views: facts.views,
          doctor: facts.doctor,
          lastNote: record.lastNote,
        });
        const started = await deps
          .run({ bindingId: space.bindingId, userId: me, prompt: GARDENER_PROMPT, context, mayRename })
          .catch(() => null);
        if (!started) {
          deps.store.set(space.bindingId, { ...record, lastStatus: 'not_started' });
          return space.bindingId;
        }
        void started.done
          .catch(() => ({ status: 'failed', answer: '' }))
          .then(async ({ status, answer }) => {
            const after = (await deps.fingerprint(space.path).catch(() => null)) ?? before;
            // Read again: the record may have changed (a rename seen by a later tick) while the pass ran.
            const current = deps.store.get(space.bindingId) ?? record;
            deps.store.set(space.bindingId, {
              ...current,
              lastFinishedMs: deps.now(),
              lastStatus: status === 'done' || status === 'stopped' ? status : 'failed',
              fingerprint: after,
              lastNote: noteOf(answer),
            });
          });
        return space.bindingId;
      }
      return null;
    } finally {
      ticking = false;
    }
  }

  return { tick };
}

/** The views' facts, cut so a huge page list cannot swell the turn. */
export function cutFacts(text: string): string {
  return text.slice(0, FACTS_MAX);
}
