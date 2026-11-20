import { describe, expect, it } from 'vitest';
import type { SpaceRun, SpaceState, ViewWork } from '@shared/rig/space-state';
import type { ViewManifest } from '@shared/rig/views';
import {
  ago,
  clock,
  everyInWords,
  newlyScheduled,
  lastInWords,
  nextInWords,
  ownerRefreshOf,
  roomRowStatus,
  runningEntries,
  standingLine,
  stepMatrix,
  untilInWords,
  viewRowStatus,
} from './space-status';

const MIN = 60_000;
const H = 60 * MIN;
const at = (h: number, m = 0, day = 13) => new Date(2026, 10, day, h, m).getTime();
const NOW = at(14, 0);

const manifest = (over: Partial<ViewManifest> = {}): ViewManifest => ({
  name: 'prs',
  kind: 'prs',
  icon: null,
  order: null,
  title: 'Pull requests',
  sub: null,
  counts: null,
  failed: false,
  note: null,
  updatedMs: NOW - 5 * MIN,
  every: '1h',
  everyMs: H,
  ...over,
});
const work = (over: Partial<ViewWork> = {}): ViewWork => ({
  view: 'prs',
  everyMs: H,
  runsAs: 'usr_me',
  runsHere: true,
  needsAccept: false,
  dataModifiedMs: NOW - 5 * MIN,
  refreshingRunId: null,
  lastRefresh: null,
  nextDueAt: at(15),
  skipped: null,
  ...over,
});
const run = (over: Partial<SpaceRun> = {}): SpaceRun => ({
  runId: 'r1',
  startedBy: 'clock',
  view: 'prs',
  ownerUserId: 'usr_me',
  agent: 'claude',
  startedAt: NOW - MIN,
  state: 'working',
  step: 'Reading FACTORY.md',
  stepKind: 'reading',
  lastEventAt: NOW,
  endedAt: null,
  ...over,
});
const row = (over: Record<string, unknown> = {}) =>
  viewRowStatus({
    manifest: manifest(),
    work: work(),
    runs: [],
    turnRunning: false,
    unseen: false,
    justScheduled: false,
    viewerId: 'usr_me',
    now: NOW,
    ...over,
  });
const line = (over: Record<string, unknown> = {}) =>
  standingLine({
    manifest: manifest(),
    work: work(),
    runs: [],
    turnRunning: false,
    justScheduled: false,
    runsAsName: null,
    now: NOW,
    ...over,
  });

describe('words', () => {
  it('ago', () => {
    expect(ago(NOW, NOW)).toBe('just now');
    expect(ago(NOW - 5 * MIN, NOW)).toBe('5 min ago');
    expect(ago(NOW - 2 * H, NOW)).toBe('2 h ago');
    expect(ago(NOW - 72 * H, NOW)).toBe('3 d ago');
  });
  it('everyInWords, for a set time: the days and the hour, on this clock', () => {
    const DAY = 24 * H;
    const set = (days: number[] | null, minute: number) => ({ days, minute, tz: null, fromMs: null });
    expect(everyInWords(7 * DAY, set([5], 15 * 60), NOW)).toBe('every Friday at 15:00');
    expect(everyInWords(DAY, set(null, 9 * 60), NOW)).toBe('every day at 09:00');
    expect(everyInWords(3 * DAY, set([1, 2, 3, 4, 5], 9 * 60), NOW)).toBe('every weekday at 09:00');
    expect(everyInWords(3 * DAY, set([0, 1, 3], 9 * 60 + 30), NOW)).toBe('every Mon, Wed and Sun at 09:30');
    // Before its first day, it still says the day it runs on.
    expect(everyInWords(7 * DAY, { ...set([5], 15 * 60), fromMs: NOW + 30 * DAY }, NOW)).toBe('every Friday at 15:00');
  });
  it('a view on a set time says it in its tooltip, with when it is next', () => {
    const friday = { days: [5], minute: 15 * 60, tz: null, fromMs: null };
    const s = row({
      manifest: manifest({ everyMs: 7 * 24 * H, at: friday }),
      work: work({ everyMs: 7 * 24 * H, at: friday, nextDueAt: at(15, 0, 20) }),
    });
    expect(s.tooltip).toBe('Updated 5 min ago. Refreshes every Friday at 15:00, next in 7 days.');
  });
  it('everyInWords', () => {
    expect(everyInWords(30 * MIN)).toBe('every 30 min');
    expect(everyInWords(60 * MIN)).toBe('every hour');
    expect(everyInWords(90 * MIN)).toBe('every 90 min');
    expect(everyInWords(2 * H)).toBe('every 2 hours');
    expect(everyInWords(24 * H)).toBe('every day');
    expect(everyInWords(48 * H)).toBe('every 2 days');
  });
  it('clock', () => {
    expect(clock(at(9, 5))).toBe('09:05');
    expect(clock(at(15, 0))).toBe('15:00');
  });
  it('nextInWords', () => {
    expect(nextInWords(NOW + 30_000, NOW)).toBe('due now');
    expect(nextInWords(0, NOW)).toBe('due now');
    expect(nextInWords(at(15), NOW)).toBe('next at 15:00');
    expect(nextInWords(at(9, 0, 14), NOW)).toBe('next tomorrow at 09:00');
    expect(nextInWords(at(9, 0, 16), NOW)).toBe('next in 3 days');
  });
  it('stepMatrix', () => {
    const kind = (stepKind: SpaceRun['stepKind']) => stepMatrix(run({ stepKind }));
    expect(stepMatrix(run({ state: 'waiting' }))).toEqual({ state: 'waiting', tone: 'warn' });
    expect(kind('starting')).toEqual({ state: 'starting' });
    expect(kind('thinking')).toEqual({ state: 'thinking' });
    expect(kind('reading')).toEqual({ state: 'reading' });
    expect(kind('writing')).toEqual({ state: 'editing' });
    expect(kind('searching')).toEqual({ state: 'searching' });
    expect(kind('running')).toEqual({ state: 'running' });
    expect(kind('tool')).toEqual({ state: 'running' });
    expect(kind('replying')).toEqual({ state: 'thinking' });
  });
  it('newlyScheduled', () => {
    const views = [manifest()];
    expect(newlyScheduled(null, views)).toEqual([]);
    expect(newlyScheduled(new Map([['prs', null]]), views)).toEqual(['prs']);
    // A view not known before (still loading in, or new with its schedule) did not just get one.
    expect(newlyScheduled(new Map(), views)).toEqual([]);
    expect(newlyScheduled(new Map([['prs', H]]), views)).toEqual([]);
    expect(newlyScheduled(new Map(), [manifest({ every: null, everyMs: null })])).toEqual([]);
  });
});

describe('viewRowStatus', () => {
  it('A1 waiting', () => {
    const s = row({ runs: [run({ state: 'waiting' })], manifest: manifest({ failed: true }) });
    expect(s.text).toBe('Waiting on you');
    expect(s.tone).toBe('warn');
    expect(s.matrix).toEqual({ state: 'waiting', tone: 'warn' });
  });
  it('A2 working, by starter', () => {
    expect(row({ runs: [run()] }).text).toBe('Refreshing · Reading FACTORY.md');
    const w = row({
      runs: [run({ startedBy: 'view', step: 'Writing data.json', stepKind: 'writing' })],
    });
    expect(w.text).toBe('Writing data.json');
    expect(w.matrix).toEqual({ state: 'editing' });
    expect(row({ runs: [run({ startedBy: 'gardener' })] }).text).toMatch(
      /^Reading FACTORY.md|^Rig is looking after this space/
    );
    expect(row({ runs: [run({ startedBy: 'message' })] }).text).toMatch(/^Reading FACTORY.md|^Replying to you/);
    expect(row({ runs: [run({ startedBy: 'comment' })] }).text).toMatch(/^Reading FACTORY.md/);
  });
  it('A2 instant fallback', () => {
    const s = row({ turnRunning: true });
    expect(s.text).toBe('Starting');
    expect(s.matrix).toEqual({ state: 'starting' });
  });
  it('A3 unseen', () => {
    const s = row({ unseen: true, manifest: manifest({ sub: 'own words' }) });
    expect(s.text).toBe('Refreshes every hour, next at 15:00');
    expect(s.arrived).toBe(true);
    const none = row({
      unseen: true,
      manifest: manifest({ every: null, everyMs: null }),
      work: undefined,
    });
    expect(none.text).toBe('Just added');
  });
  it('A4 schedule just appeared', () => {
    expect(row({ justScheduled: true }).text).toBe('Now refreshes every hour, next at 15:00');
  });
  it('A5 failed manifest', () => {
    expect(row({ manifest: manifest({ failed: true, note: 'No token' }) })).toMatchObject({
      text: 'No token',
      tone: 'bad',
    });
    expect(row({ manifest: manifest({ failed: true }) }).text).toBe("Couldn't refresh");
  });
  it('A6 last refresh', () => {
    const last = (result: 'failed' | 'not_started' | 'stopped', finishedAt = at(13, 30)) => ({
      startedAt: finishedAt - MIN,
      finishedAt,
      startedBy: 'clock' as const,
      result,
    });
    const dataModifiedMs = at(13, 0);
    expect(row({ work: work({ dataModifiedMs, lastRefresh: last('failed') }) })).toMatchObject({
      text: 'Last refresh failed at 13:30',
      tone: 'bad',
    });
    expect(row({ work: work({ dataModifiedMs, lastRefresh: last('not_started') }) }).text).toBe(
      'Last refresh failed at 13:30'
    );
    expect(row({ work: work({ dataModifiedMs, lastRefresh: last('stopped') }) })).toMatchObject({
      text: 'Refresh stopped at 13:30',
      tone: 'warn',
    });
    // Data changed after the failure: the failure is old news.
    expect(
      row({ work: work({ dataModifiedMs: at(13, 45), lastRefresh: last('failed') }) }).text
    ).toBe('Next at 15:00');
  });
  it('A7 stale', () => {
    const s = row({ manifest: manifest({ updatedMs: NOW - 5 * H }) });
    expect(s).toMatchObject({ text: 'Updated 5 h ago, overdue', tone: 'warn' });
  });
  it('A8 own words', () => {
    expect(row({ manifest: manifest({ sub: '3 open' }) })).toMatchObject({
      text: '3 open',
      fresh: '5m',
    });
    expect(row({ manifest: manifest({ sub: '3 open', updatedMs: null }) }).text).toBe('3 open');
  });
  it('A9 updated', () => {
    expect(row()).toMatchObject({ text: 'Next at 15:00', fresh: '5m' });
    expect(row({ work: undefined })).toMatchObject({ text: '', fresh: '5m' });
    expect(row({ manifest: manifest({ every: null, everyMs: null }) })).toMatchObject({
      text: '',
      fresh: '5m',
    });
  });
  it('A10 no data', () => {
    expect(row({ manifest: manifest({ updatedMs: null }) }).text).toBe('No data yet');
  });
  it('orders its rules', () => {
    const failed = manifest({ failed: true, note: 'x', sub: 'own' });
    expect(row({ manifest: failed, unseen: true }).text).toBe(
      'Refreshes every hour, next at 15:00'
    );
    expect(
      row({ manifest: manifest({ sub: 'own' }), work: work({ nextDueAt: at(15) }) }).text
    ).toBe('own');
  });
  it('tooltips', () => {
    expect(row().tooltip).toBe('Updated 5 min ago. Refreshes every hour, next at 15:00.');
    expect(
      row({ manifest: manifest({ every: null, everyMs: null, sub: 'own' }), work: undefined })
        .tooltip
    ).toBe('Updated 5 min ago. No schedule yet.');
    expect(
      row({ manifest: manifest({ updatedMs: null, every: null, everyMs: null }) }).tooltip
    ).toBe('No schedule yet.');
  });
});

describe('standingLine', () => {
  it('B1 waiting', () => {
    expect(line({ runs: [run({ state: 'waiting' })] })).toMatchObject({
      text: 'Waiting on you',
      tone: 'warn',
      matrix: { state: 'waiting', tone: 'warn' },
    });
  });
  it('B2 working', () => {
    expect(line({ runs: [run()] })).toMatchObject({
      text: 'Refreshing · Reading FACTORY.md',
      matrix: { state: 'reading' },
    });
  });
  it('B3 another Mac', () => {
    const w = work({ runsHere: false, runsAs: 'usr_sam' });
    expect(line({ work: w, runsAsName: 'Sam' }).text).toBe("Every hour, in Sam's Rig app");
    expect(line({ work: w }).text).toBe("Every hour, in another member's Rig app");
  });
  it('B4 just scheduled', () => {
    expect(line({ justScheduled: true })).toMatchObject({
      text: 'Now refreshes every hour, next at 15:00',
      arrived: true,
      matrix: { state: 'standby', tone: 'mute' },
    });
  });
  it('B5 skipped', () => {
    expect(line({ work: work({ skipped: { reason: 'busy', at: NOW } }) }).text).toBe(
      'Due now, after the current work finishes'
    );
    expect(line({ work: work({ skipped: { reason: 'queued', at: NOW } }) }).text).toBe(
      'Due now, after another view refreshes'
    );
  });
  it('B6 last refresh', () => {
    const last = (result: 'failed' | 'not_started' | 'stopped') => ({
      startedAt: at(13, 29),
      finishedAt: at(13, 30),
      startedBy: 'clock' as const,
      result,
    });
    const base = { dataModifiedMs: at(13, 0), nextDueAt: at(15) };
    expect(line({ work: work({ ...base, lastRefresh: last('failed') }) })).toMatchObject({
      text: 'Refresh failed at 13:30, next try at 15:00',
      tone: 'bad',
      matrix: { state: 'failed' },
    });
    expect(line({ work: work({ ...base, lastRefresh: last('not_started') }) }).text).toBe(
      "Couldn't start a refresh at 13:30, next try at 15:00"
    );
    expect(line({ work: work({ ...base, lastRefresh: last('stopped') }) })).toMatchObject({
      text: 'Refresh stopped at 13:30, next at 15:00',
      matrix: { state: 'stopped' },
    });
  });
  it('B7 no data', () => {
    expect(line({ manifest: manifest({ updatedMs: null }) }).text).toBe(
      'Every hour, first refresh soon'
    );
  });
  it('B8 at rest', () => {
    expect(line().text).toBe('Updated 5 min ago, next at 15:00');
    expect(
      line({ manifest: manifest({ updatedMs: NOW - H }), work: work({ nextDueAt: 0 }) }).text
    ).toBe('Updated 1 h ago, due now');
    expect(line().matrix).toEqual({ state: 'standby', tone: 'mute' });
  });
  it('B9 no runtime state', () => {
    expect(line({ work: undefined }).text).toBe('Every hour, while Rig is open');
  });
});

describe('roomRowStatus', () => {
  const views = [manifest()];
  const room = (runs: SpaceRun[], viewTurns: string[] = []) =>
    roomRowStatus({ runs, viewTurns, views });
  it('says each starter', () => {
    expect(room([run({ startedBy: 'message', view: null })]).text).toBe(
      'Reading FACTORY.md'
    );
    expect(room([run({ startedBy: 'view' })]).text).toBe('Working on Pull requests');
    expect(room([run({ startedBy: 'clock' })]).text).toBe('Refreshing Pull requests');
    expect(room([run({ startedBy: 'gardener', view: null })]).text).toBe('Rig is looking after it');
    expect(room([run({ startedBy: 'comment', view: null })]).text).toBe(
      'Reading FACTORY.md'
    );
    expect(room([run()]).matrix).toEqual({ state: 'reading' });
  });
  it('waiting, fallback, idle', () => {
    expect(room([run({ state: 'waiting' })])).toMatchObject({
      text: 'Waiting on you',
      tone: 'warn',
    });
    expect(room([], ['prs']).text).toBe('Claude is working');
    expect(room([run({ state: 'done' })])).toEqual({ text: '' });
  });
});

describe('runningEntries', () => {
  const state = (runs: SpaceRun[], works: ViewWork[] = []): SpaceState => ({
    bindingId: 'b',
    at: NOW,
    views: works,
    runs,
  });
  const entries = (over: Record<string, unknown> = {}) =>
    runningEntries({
      views: [manifest()],
      state: state([]),
      agents: [],
      agentName: { claude: 'Claude', codex: 'Codex' },
      viewTurns: [],
      justScheduled: new Set<string>(),
      members: [{ id: 'usr_sam', name: 'Sam' }],
      now: NOW,
      ...over,
    });
  const agent = (mine: boolean) => ({
    key: 'k',
    agent: 'claude' as const,
    mine,
    state: 'thinking' as const,
    label: mine ? 'Claude working' : "Sam's Claude working",
  });
  it('asks the person to accept a schedule another member set or changed, instead of offering to run it', () => {
    const s = state([], [work({ needsAccept: true })]);
    expect(entries({ state: s })).toEqual([
      expect.objectContaining({
        key: 'accept:prs',
        label: 'Pull requests: schedule changed',
        sub: 'Every hour',
        subTone: 'warn',
        accept: 'prs',
      }),
    ]);
    expect(entries({ state: s })[0].runNow).toBeUndefined();
  });
  it('gives my agent its sub, not another member', () => {
    const s = state([run()], [work()]);
    expect(entries({ state: s, agents: [agent(true)] })[0]).toMatchObject({
      label: 'Refreshing Pull requests',
      sub: 'Reading FACTORY.md',
      matrix: 'reading',
    });
    const theirs = entries({ state: s, agents: [agent(false)] });
    expect(theirs[0]!.sub).toBeUndefined();
    // The state's run has no card in the Room for my agent: it gets its own entry.
    expect(theirs.find((e) => e.key === 'run:claude')).toBeDefined();
  });
  it('adds an entry when the Room has none', () => {
    const list = entries({ state: state([run({ startedBy: 'message', view: null })]) });
    expect(list[0]).toMatchObject({
      key: 'run:claude',
      label: 'Claude is replying',
      sub: 'Reading FACTORY.md',
    });
    // A pass that waits on the person says so first, in the warning tone, and where.
    const waiting = entries({ state: state([run({ state: 'waiting' })]) });
    expect(waiting[0]).toMatchObject({
      label: 'Claude needs you',
      sub: 'In Pull requests',
      subTone: 'warn',
      matrix: 'waiting',
      matrixTone: 'warn',
    });
  });
  it('lists no schedule at rest; with nothing going, one entry says what runs next', () => {
    const views = [
      manifest({ name: 'zeta', title: null }),
      manifest({ name: 'alpha' }),
      manifest({ name: 'manual', every: null, everyMs: null }),
    ];
    const s = state(
      [],
      [work({ view: 'zeta', nextDueAt: at(16) }), work({ view: 'alpha', nextDueAt: at(15) })]
    );
    const list = entries({ views, state: s });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: 'next:alpha',
      label: 'Next: Pull requests',
      sub: 'In 1 h, at 15:00',
      matrix: 'standby',
      runNow: 'alpha',
    });
    // A pass going replaces it.
    expect(entries({ views, state: state([run()], s.views) }).map((e) => e.key)).toEqual([
      'run:claude',
    ]);
  });
  it('says nothing when nothing is going and nothing is scheduled here', () => {
    expect(entries({ views: [manifest({ every: null, everyMs: null })], state: state([]) })).toEqual(
      []
    );
    expect(entries({ state: state([], [work({ runsHere: false, runsAs: 'usr_sam' })]) })).toEqual(
      []
    );
  });
});

describe('untilInWords', () => {
  it('says how far off a run is, then the time on the clock', () => {
    expect(untilInWords(NOW + 30_000, NOW)).toBe('Due now');
    expect(untilInWords(NOW + 20 * MIN, NOW)).toBe('In 20 min');
    expect(untilInWords(at(0, 20, 14), at(10, 41, 13))).toBe('In 14 h, at 00:20');
    expect(untilInWords(NOW + 5 * 24 * H, NOW)).toBe('In 5 days');
  });
});

describe('copy', () => {
  it('has no em dashes', () => {
    const texts: string[] = [
      row().text,
      row({ runs: [run()] }).text,
      row().tooltip,
      line().text,
      line({ work: undefined }).text,
      roomRowStatus({ runs: [run()], viewTurns: [], views: [manifest()] }).text,
      ...runningEntries({
        views: [manifest()],
        state: { bindingId: 'b', at: NOW, views: [work()], runs: [run()] },
        agents: [],
        agentName: { claude: 'Claude', codex: 'Codex' },
        viewTurns: [],
        justScheduled: new Set(),
        members: [],
        now: NOW,
      }).flatMap((e) => [e.label, e.sub ?? '', e.tooltip ?? '']),
    ];
    for (const text of texts) expect(text).not.toContain('—');
  });
});

describe('a schedule that waits for the person to accept it', () => {
  it('says so on the tab, in place of when it next runs', () => {
    expect(row({ work: work({ needsAccept: true }) })).toMatchObject({
      text: 'Refreshes every hour once you accept',
      tone: 'warn',
    });
  });
  it('says so on the standing line', () => {
    expect(
      standingLine({
        manifest: manifest(),
        work: work({ needsAccept: true }),
        runs: [],
        turnRunning: false,
        justScheduled: false,
        runsAsName: null,
        now: NOW,
      })
    ).toMatchObject({ text: 'Every hour, once you accept', tone: 'warn' });
  });
});

describe('a view another member\'s app keeps fresh', () => {
  const theirs = (over: Partial<ViewWork> = {}) => work({ runsHere: false, runsAs: 'usr_sam', ...over });
  const refresh = (over: Record<string, unknown> = {}) => ({
    state: 'done' as const,
    startedAt: at(13, 0),
    endedAt: at(13, 1),
    lastWordAt: at(13, 1),
    reason: null,
    ...over,
  });
  it('says nothing more while it is on schedule', () => {
    expect(row({ work: theirs(), runsAsName: 'Sam' }).text).not.toContain('Waiting');
  });
  it('says whose Mac it waits on once it is past its time, with the last refresh in the tooltip', () => {
    const late = manifest({ updatedMs: at(12, 30) }); // hourly, now 14:00
    expect(row({ manifest: late, work: theirs(), runsAsName: 'Sam Lee' })).toMatchObject({
      text: "Waiting on Sam's Mac",
      fresh: '2h',
      tone: 'warn',
      tooltip: "Waiting on Sam's Mac · last refresh 12:30",
    });
    expect(row({ manifest: late, work: theirs(), runsAsName: 'sam@example.com' }).text).toBe("Waiting on sam's Mac");
    expect(row({ manifest: late, work: theirs(), runsAsName: null }).text).toBe(
      "Waiting on another member's Mac"
    );
  });
  it('gives the day when the last refresh was not today', () => {
    expect(lastInWords(at(13, 0, 12), NOW)).toBe('yesterday 13:00');
    expect(lastInWords(at(13, 0, 10), NOW)).toBe('3 days ago');
  });
  it('does not say it waits on my own Mac', () => {
    const late = manifest({ updatedMs: at(10, 0) });
    expect(row({ manifest: late, work: work(), runsAsName: 'Sam' }).text).not.toContain('Waiting on');
  });
  it('shows their refresh going, but not one that went quiet', () => {
    const going = refresh({ state: 'running', endedAt: null, startedAt: NOW - 2 * MIN, lastWordAt: NOW - MIN });
    expect(row({ work: theirs(), runsAsName: 'Sam', ownerRefresh: going }).text).toBe(
      "Refreshing in Sam's Rig app"
    );
    const quiet = refresh({ state: 'running', endedAt: null, startedAt: NOW - 40 * MIN, lastWordAt: NOW - 40 * MIN });
    expect(row({ work: theirs(), runsAsName: 'Sam', ownerRefresh: quiet })).toMatchObject({
      text: "Waiting on Sam's Mac",
      tooltip: "Waiting on Sam's Mac · last refresh 13:55",
      tone: 'warn',
    });
  });
  it('says their last refresh failed, with the run\'s own reason when it gave one', () => {
    const failed = refresh({ state: 'failed', startedAt: at(13, 58), endedAt: at(13, 58) });
    expect(row({ work: theirs(), runsAsName: 'Sam', ownerRefresh: failed })).toMatchObject({
      text: "Sam's refresh failed at 13:58",
      tooltip: "Refresh failed in Sam's Rig app at 13:58",
      tone: 'bad',
    });
    const why = { ...failed, reason: "Sam's Claude needs to sign in again." };
    expect(row({ work: theirs(), runsAsName: 'Sam', ownerRefresh: why }).tooltip).toBe(
      "Refresh failed at 13:58: Sam's Claude needs to sign in again."
    );
  });
  it('forgets a failure once the view has refreshed since', () => {
    const old = refresh({ state: 'failed', startedAt: at(13, 0), endedAt: at(13, 0) });
    expect(row({ work: theirs(), runsAsName: 'Sam', ownerRefresh: old }).text).not.toContain('failed');
  });
  it('says the same on the standing line', () => {
    expect(
      standingLine({
        manifest: manifest({ updatedMs: at(12, 30) }),
        work: theirs(),
        runs: [],
        turnRunning: false,
        justScheduled: false,
        runsAsName: 'Sam',
        now: NOW,
      })
    ).toMatchObject({ text: "Waiting on Sam's Mac · last refresh 12:30", tone: 'warn' });
  });
});

describe('ownerRefreshOf', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    owner: 'usr_sam',
    title: 'Scheduled refresh of the "prs" view. Read the open pull requests.',
    status: 'done',
    startedAt: new Date(at(13, 0)).toISOString(),
    endedAt: new Date(at(13, 1)).toISOString(),
    ...over,
  });
  it('picks the newest scheduled refresh of the view by the member who runs it', () => {
    const newest = run({ status: 'failed', startedAt: new Date(at(13, 30)).toISOString(), endedAt: new Date(at(13, 30)).toISOString(), reason: ' out of credits ' });
    expect(ownerRefreshOf({ view: 'prs', runsAs: 'usr_sam', runs: [run(), newest] })).toEqual({
      state: 'failed',
      startedAt: at(13, 30),
      endedAt: at(13, 30),
      lastWordAt: at(13, 30),
      reason: 'out of credits',
    });
  });
  it('ignores other members\' runs, other views and runs that are not scheduled refreshes', () => {
    const runs = [
      run({ owner: 'usr_me' }),
      run({ title: 'Scheduled refresh of the "inbox" view.' }),
      run({ title: 'From the "prs" view, Sam chose "approve".' }),
    ];
    expect(ownerRefreshOf({ view: 'prs', runsAs: 'usr_sam', runs })).toBeNull();
    expect(ownerRefreshOf({ view: 'prs', runsAs: null, runs: [run()] })).toBeNull();
  });
  it('reads a run with no end as still going, from its last word', () => {
    const going = run({ status: 'running', endedAt: null, lastWordAt: at(13, 4) });
    expect(ownerRefreshOf({ view: 'prs', runsAs: 'usr_sam', runs: [going] })).toMatchObject({
      state: 'running',
      endedAt: null,
      lastWordAt: at(13, 4),
    });
  });
});
