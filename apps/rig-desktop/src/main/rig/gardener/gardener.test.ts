import { describe, expect, it, vi } from 'vitest';
import {
  createGardener,
  GARDENER_CHECK_EVERY_MS,
  GARDENER_MAX_PER_DAY,
  GARDENER_MIN_GAP_MS,
  GARDENER_NOTE_MAX,
  GARDENER_QUIET_MS,
  gardenerContext,
  spaceFingerprint,
  type GardenerDeps,
  type GardenerRecord,
} from './gardener';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

type Space = Awaited<ReturnType<GardenerDeps['spaces']>>[number];
const space = (over: Partial<Space> = {}): Space => ({
  bindingId: 'bnd_1',
  path: '/spaces/one',
  name: 'PR reviews',
  role: 'owner',
  ...over,
});

function setup(over: Partial<GardenerDeps> & { list?: Space[]; records?: Record<string, GardenerRecord> } = {}) {
  const { list, records, ...rest } = over;
  const saved: Record<string, GardenerRecord> = { ...(records ?? {}) };
  const runs: Parameters<GardenerDeps['run']>[0][] = [];
  const finish: { resolve: (v: { status: string; answer: string }) => void }[] = [];
  const fingerprint = vi.fn(async (_path: string): Promise<string | null> => '3:9');
  const deps: GardenerDeps = {
    enabled: () => true,
    me: async () => 'usr_me',
    elsewhere: () => false,
    spaces: async () => list ?? [space()],
    busy: () => false,
    lastTurnAt: (): number | null => NOW - 2 * GARDENER_QUIET_MS,
    fingerprint,
    facts: async () => ({ views: '[]', doctor: null }),
    run: async (spec) => {
      runs.push(spec);
      return {
        done: new Promise((resolve) => finish.push({ resolve })),
      };
    },
    store: { get: (id) => saved[id] ?? null, set: (id, record) => void (saved[id] = record) },
    now: () => NOW,
    ...rest,
  };
  return { gardener: createGardener(deps), runs, saved, fingerprint, finish };
}

const quietFor = (ms: number): number => NOW - ms;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const record = (over: Partial<GardenerRecord> = {}): GardenerRecord => ({
  starts: [],
  lastStartedMs: null,
  lastFinishedMs: null,
  lastStatus: null,
  fingerprint: null,
  lastNote: null,
  nameAtStart: null,
  renameDone: false,
  ...over,
});

describe('spaceFingerprint', () => {
  it('counts the files and takes the newest change', () => {
    expect(spaceFingerprint([])).toBe('0:0');
    expect(
      spaceFingerprint([
        { relPath: 'a', mtimeMs: 10.9 },
        { relPath: 'b', mtimeMs: 42.5 },
      ])
    ).toBe('2:42');
  });
});

describe('createGardener: when it starts', () => {
  it('starts one pass for an owner’s changed, quiet, idle space', async () => {
    const { gardener, runs, saved } = setup();
    expect(await gardener.tick()).toBe('bnd_1');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ bindingId: 'bnd_1', userId: 'usr_me', prompt: 'Looking over this space.', mayRename: false });
    expect(saved.bnd_1).toMatchObject({ lastStartedMs: NOW, starts: [NOW] });
  });

  const skips: [string, Partial<GardenerDeps> & { list?: Space[] }][] = [
    ['an editor', { list: [space({ role: 'editor' })] }],
    ['another Mac', { elsewhere: () => true }],
    ['disabled', { enabled: () => false }],
    ['signed out', { me: async () => null }],
    ['a turn in progress', { busy: () => true }],
    ['under 10 minutes of quiet', { lastTurnAt: () => quietFor(GARDENER_QUIET_MS - 1) }],
    ['no stored turn', { lastTurnAt: () => null }],
    ['an unreadable folder', { fingerprint: async () => null }],
  ];
  it.each(skips)('skips for %s', async (_name, over) => {
    const { gardener, runs } = setup(over);
    expect(await gardener.tick()).toBeNull();
    expect(runs).toHaveLength(0);
  });

  it('skips within 60 minutes of the last start, then starts', async () => {
    const recent = record({ lastStartedMs: NOW - GARDENER_MIN_GAP_MS + 1, starts: [NOW - GARDENER_MIN_GAP_MS + 1] });
    expect(await setup({ records: { bnd_1: recent } }).gardener.tick()).toBeNull();
    const ok = record({ lastStartedMs: NOW - GARDENER_MIN_GAP_MS, starts: [NOW - GARDENER_MIN_GAP_MS] });
    expect(await setup({ records: { bnd_1: ok } }).gardener.tick()).toBe('bnd_1');
  });

  it('stops after 6 starts in 24 h and starts again once the oldest falls out', async () => {
    const day = 24 * HOUR;
    const starts = Array.from({ length: GARDENER_MAX_PER_DAY }, (_, i) => NOW - day + (i + 1) * 3 * HOUR - 1 * HOUR);
    const full = record({ starts, lastStartedMs: starts.at(-1)! });
    expect(await setup({ records: { bnd_1: full } }).gardener.tick()).toBeNull();
    const aged = [NOW - day - 1, ...starts.slice(1)];
    expect(await setup({ records: { bnd_1: { ...full, starts: aged } } }).gardener.tick()).toBe('bnd_1');
  });

  it('does not walk the folder when an earlier check fails', async () => {
    for (const over of [
      { list: [space({ role: 'viewer' })] },
      { busy: () => true },
      { lastTurnAt: () => null },
      { records: { bnd_1: record({ lastStartedMs: NOW - 1 }) } },
    ]) {
      const { gardener, fingerprint } = setup(over);
      await gardener.tick();
      expect(fingerprint).not.toHaveBeenCalled();
    }
  });

  it('starts one pass per tick with two eligible spaces', async () => {
    const { gardener, runs } = setup({ list: [space(), space({ bindingId: 'bnd_2', path: '/spaces/two' })] });
    expect(await gardener.tick()).toBe('bnd_1');
    expect(runs).toHaveLength(1);
  });

  it('walks an unchanged space once per check interval, not every tick', async () => {
    let now = NOW;
    const { gardener, fingerprint } = setup({
      now: () => now,
      lastTurnAt: () => now - 2 * GARDENER_QUIET_MS,
      records: { bnd_1: record({ fingerprint: '3:9' }) },
    });
    await gardener.tick();
    now += 60_000;
    await gardener.tick();
    expect(fingerprint).toHaveBeenCalledTimes(1);
    now += GARDENER_CHECK_EVERY_MS;
    await gardener.tick();
    expect(fingerprint).toHaveBeenCalledTimes(2);
  });

  it('skips an unchanged space', async () => {
    const { gardener, runs } = setup({ records: { bnd_1: record({ fingerprint: '3:9' }) } });
    expect(await gardener.tick()).toBeNull();
    expect(runs).toHaveLength(0);
  });
});

describe('createGardener: the record of a pass', () => {
  it('saves the fingerprint taken after the pass, not before', async () => {
    let calls = 0;
    const { gardener, saved, finish } = setup({ fingerprint: async () => (++calls === 1 ? '3:9' : '4:20') });
    await gardener.tick();
    finish[0]!.resolve({ status: 'done', answer: 'Fixed a link in FACTORY.md.' });
    await flush();
    expect(saved.bnd_1).toMatchObject({ fingerprint: '4:20', lastStatus: 'done', lastFinishedMs: NOW, lastNote: 'Fixed a link in FACTORY.md.' });
  });

  it('keeps a failed pass from running again until the space changes', async () => {
    const { gardener, saved, finish, runs } = setup();
    await gardener.tick();
    finish[0]!.resolve({ status: 'failed', answer: '' });
    await flush();
    expect(saved.bnd_1).toMatchObject({ lastStatus: 'failed', fingerprint: '3:9' });
    saved.bnd_1 = { ...saved.bnd_1!, lastStartedMs: NOW - 2 * GARDENER_MIN_GAP_MS };
    expect(await gardener.tick()).toBeNull();
    expect(runs).toHaveLength(1);
  });

  it('records not_started and still holds the gap', async () => {
    const { gardener, saved } = setup({ run: async () => null });
    expect(await gardener.tick()).toBe('bnd_1');
    expect(saved.bnd_1).toMatchObject({ lastStatus: 'not_started', lastStartedMs: NOW });
    expect(await gardener.tick()).toBeNull();
  });

  it('keeps no note for the silent reply, and cuts a long one', async () => {
    for (const answer of ['All is well.', 'all is well', '  ALL IS WELL.  ', '']) {
      const { gardener, saved, finish } = setup();
      await gardener.tick();
      finish[0]!.resolve({ status: 'done', answer });
      await flush();
      expect(saved.bnd_1!.lastNote, answer).toBeNull();
    }
    const { gardener, saved, finish } = setup();
    await gardener.tick();
    finish[0]!.resolve({ status: 'done', answer: 'x'.repeat(GARDENER_NOTE_MAX + 500) });
    await flush();
    expect(saved.bnd_1!.lastNote).toHaveLength(GARDENER_NOTE_MAX);
  });
});

describe('createGardener: the free rename', () => {
  it('is offered for a generated name that has not been renamed', async () => {
    const { gardener, runs, saved } = setup({ list: [space({ name: 'bright-harbor' })] });
    await gardener.tick();
    expect(runs[0]!.mayRename).toBe(true);
    expect(runs[0]!.context).toContain('You may rename it once with rig_space_rename without asking.');
    expect(saved.bnd_1!.nameAtStart).toBe('bright-harbor');
  });

  it('is not offered for a name a person chose', async () => {
    const { gardener, runs } = setup();
    await gardener.tick();
    expect(runs[0]!.mayRename).toBe(false);
  });

  it('is never offered again once the name changed since the pass began', async () => {
    const { gardener, runs, saved } = setup({
      list: [space({ name: 'PR reviews' })],
      records: { bnd_1: record({ nameAtStart: 'bright-harbor' }) },
    });
    await gardener.tick();
    expect(saved.bnd_1!.renameDone).toBe(true);
    expect(runs[0]!.mayRename).toBe(false);
  });

  it('does not offer it when renameDone is set, even if the name looks generated', async () => {
    const { gardener, runs } = setup({
      list: [space({ name: 'calm-ridge' })],
      records: { bnd_1: record({ renameDone: true }) },
    });
    await gardener.tick();
    expect(runs[0]!.mayRename).toBe(false);
    expect(runs[0]!.context).toContain('renaming it now asks your owner first');
  });
});

describe('gardenerContext', () => {
  const base = { name: 'x', nameIsRandom: false, mayRename: false, views: '[]', doctor: null, lastNote: null };
  it('always carries the fixed sentences', () => {
    const text = gardenerContext(base);
    expect(text).toContain("started by Rig's regular look over the space, not by a person. Nobody is waiting for a reply.");
    expect(text).toContain('`~/.claude/skills/rig-gardener/SKILL.md` (Codex: `~/.agents/skills/rig-gardener/SKILL.md`)');
    expect(text).toContain('reply with exactly `All is well.` and nothing else. Rig keeps that reply out of the Room.');
    expect(text).toContain('as JSON: []');
  });
  it('says what is true of the name', () => {
    expect(gardenerContext({ ...base, name: 'bright-harbor', nameIsRandom: true, mayRename: true })).toContain(
      'The space is called "bright-harbor". That name was picked at random when the space was made; nobody chose it. You may rename it once with rig_space_rename without asking.'
    );
    expect(gardenerContext({ ...base, nameIsRandom: true })).toContain(
      ' That name was picked at random, and renaming it now asks your owner first.'
    );
    expect(gardenerContext(base)).toContain(' A person chose that name.');
  });
  it('lists the other spaces only when a rename is on offer', () => {
    const random = { ...base, name: 'bright-harbor', nameIsRandom: true, otherNames: ['PR reviews', 'PR reviews', 'home'] };
    expect(gardenerContext({ ...random, mayRename: true })).toContain(
      'other spaces are called: "PR reviews", "home". A new name must differ from all of them.'
    );
    expect(gardenerContext({ ...random, mayRename: false })).not.toContain('other spaces are called');
  });
  it('says what the check found, or that it could not run', () => {
    expect(gardenerContext({ ...base, doctor: '{"ok":true}' })).toContain('(rig doctor), as JSON: {"ok":true}');
    expect(gardenerContext(base)).toContain("Rig's own check of this space could not run this time.");
  });
  it('quotes the last note, or says it is the first look', () => {
    expect(gardenerContext({ ...base, lastNote: 'Fixed a link.' })).toContain('Your last look ended with: "Fixed a link."');
    expect(gardenerContext(base)).toContain('This is your first look at this space.');
  });
});
