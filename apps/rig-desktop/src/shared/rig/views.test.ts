import { describe, expect, it } from 'vitest';
import type { RigFileNode } from './files';
import {
  checkViewAct,
  readViewManifest,
  viewCountFor,
  viewStatusFor,
  viewActPrompt,
  viewLinkToOpen,
  viewNameFromPath,
  isViewRefreshDue,
  viewNextDueMs,
  viewNamesFromListing,
  parseViewSchedule,
  viewMessageHasGesture,
  viewOfRefreshPrompt,
  viewRefreshPrompt,
  viewMetasWrittenBy,
  viewScheduleSignature,
  viewAtNextMs,
} from './views';

const file = (relPath: string): RigFileNode => ({
  name: relPath.split('/').pop()!,
  relPath,
  kind: 'file',
});
const dir = (relPath: string, children: RigFileNode[]): RigFileNode => ({
  name: relPath.split('/').pop()!,
  relPath,
  kind: 'dir',
  children,
});

describe('viewNameFromPath', () => {
  it('names the view whose page this is', () => {
    expect(viewNameFromPath('views/desk/index.html')).toBe('desk');
  });
  it('is null for anything else', () => {
    expect(viewNameFromPath('views/desk/data.json')).toBeNull();
    expect(viewNameFromPath('views/index.html')).toBeNull();
    expect(viewNameFromPath('notes/views/desk/index.html')).toBeNull();
    expect(viewNameFromPath('views/desk/sub/index.html')).toBeNull();
    expect(viewNameFromPath('views/_rig/index.html')).toBeNull();
  });
});

describe('viewNamesFromListing', () => {
  it('lists folders under views/ that hold an index.html', () => {
    const listing = [
      file('notes.md'),
      dir('views', [
        dir('views/desk', [file('views/desk/index.html'), file('views/desk/data.json')]),
        dir('views/card-demo', [file('views/card-demo/index.html')]),
        dir('views/empty', [file('views/empty/data.json')]),
        dir('views/_rig', [file('views/_rig/index.html')]),
        file('views/index.html'),
      ]),
    ];
    expect(viewNamesFromListing(listing)).toEqual(['card-demo', 'desk']);
  });
  it('is empty without a views folder', () => {
    expect(viewNamesFromListing([file('views')])).toEqual([]);
  });
});

describe('checkViewAct', () => {
  it('accepts an intent with flat text fields', () => {
    expect(
      checkViewAct({ intent: 'assign_urgent_only', payload: { id: 'a', note: 'cap at 25' } })
    ).toBeNull();
    expect(checkViewAct({ intent: 'dispatch' })).toBeNull();
  });
  it('refuses what the host spike refuses', () => {
    expect(checkViewAct({ intent: 'x'.repeat(200), payload: {} })).toBe('bad intent');
    expect(checkViewAct({ intent: 'rm -rf', payload: {} })).toBe('bad intent');
    expect(checkViewAct({ intent: 7 })).toBe('bad intent');
    expect(checkViewAct({ intent: 'dispatch', payload: [] })).toBe('bad payload');
    expect(checkViewAct({ intent: 'dispatch', payload: 'text' })).toBe('bad payload');
    expect(checkViewAct({ intent: 'dispatch', payload: { nested: { a: 1 } } })).toBe(
      'payload values must be text'
    );
    expect(checkViewAct({ intent: 'dispatch', payload: { blob: 'y'.repeat(9000) } })).toBe(
      'payload too large'
    );
  });
});

describe('viewActPrompt', () => {
  it('says who chose what, with the payload as plain lines', () => {
    expect(
      viewActPrompt({
        view: 'card-demo',
        person: 'Dylan',
        intent: 'assign_urgent_only',
        payload: { id: 'assign-134', note: 'cap Pete\nat 25' },
      })
    ).toBe(
      'From the "card-demo" view, Dylan chose "assign_urgent_only" with:\n- id: assign-134\n- note: cap Pete at 25\nDecide what to do under this space\'s rules.'
    );
  });
  it('reads as one sentence without a payload', () => {
    expect(viewActPrompt({ view: 'desk', person: 'Dylan', intent: 'refresh', payload: {} })).toBe(
      'From the "desk" view, Dylan chose "refresh". Decide what to do under this space\'s rules.'
    );
  });
});

describe('viewLinkToOpen', () => {
  it('passes web links', () => {
    expect(viewLinkToOpen('https://linear.app/acme/issue/APP-490')).toBe(
      'https://linear.app/acme/issue/APP-490'
    );
    expect(viewLinkToOpen('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
  });
  it('refuses everything else', () => {
    for (const value of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'rig-file://x/y',
      'slack://open',
      'https://user:pw@example.com/',
      'not a link',
      '',
      7,
      null,
      'https://example.com/' + 'a'.repeat(3000),
    ]) {
      expect(viewLinkToOpen(value), String(value).slice(0, 40)).toBeNull();
    }
  });
});

describe('readViewManifest', () => {
  const meta = JSON.stringify({
    kind: 'Queue',
    title: 'Drafts to review',
    every: '30m',
    runs_as: 'usr_me',
  });
  const data = (tab: unknown) => JSON.stringify({ tab, read_at: 'x', items: [] });
  const read = (tab: unknown, m: string | null = meta) =>
    readViewManifest({ name: 'drafts', meta: m, data: data(tab), dataModifiedMs: 1_000 });

  it('reads what the view declares, from both files', () => {
    expect(read({ sub: '4 to review', count: 4 })).toEqual({
      name: 'drafts',
      kind: 'queue',
      icon: null,
      order: null,
      title: 'Drafts to review',
      sub: '4 to review',
      counts: 4,
      failed: false,
      note: null,
      updatedMs: 1_000,
      every: '30m',
      everyMs: 30 * 60_000,
      at: null,
    });
  });
  it('takes a count per person, and the old badge name', () => {
    const perPerson = read({ count: { usr_me: 2, usr_you: 0, 'not-an-id': 5 } });
    expect(perPerson.counts).toEqual({ usr_me: 2 });
    expect(viewCountFor(perPerson, 'usr_me')).toBe(2);
    expect(viewCountFor(perPerson, 'usr_you')).toBe(0);
    expect(viewCountFor(perPerson, null)).toBe(0);
    expect(viewCountFor(read({ badge: 3 }), 'usr_anyone')).toBe(3);
  });
  it('is a plain page with nothing declared, or with files it cannot read', () => {
    const bare = readViewManifest({
      name: 'x',
      meta: null,
      data: '{"tab": [',
      dataModifiedMs: null,
    });
    expect(bare).toMatchObject({
      kind: 'page',
      title: null,
      sub: null,
      counts: null,
      failed: false,
      every: null,
    });
    expect(read({}, JSON.stringify({ kind: 'spaceship' })).kind).toBe('page');
    expect(read({}, JSON.stringify({ kind: 'review-queue' })).kind).toBe('queue');
    // A schedule needs both fields: without who runs it, the view does not refresh itself.
    expect(read({}, JSON.stringify({ every: '30m' })).every).toBeNull();
  });
});

describe('viewStatusFor', () => {
  const base = readViewManifest({
    name: 'drafts',
    meta: JSON.stringify({ every: '30m', runs_as: 'usr_me' }),
    data: JSON.stringify({ tab: {} }),
    dataModifiedMs: 0,
  });
  const MIN = 60_000;
  it('is ok while fresh, stale after two periods, and never stale without a schedule', () => {
    expect(viewStatusFor(base, 'usr_me', 40 * MIN)).toBe('ok');
    expect(viewStatusFor(base, 'usr_me', 62 * MIN)).toBe('stale');
    expect(viewStatusFor({ ...base, everyMs: null }, 'usr_me', 600 * MIN)).toBe('ok');
  });
  it('puts what waits on the person above staleness, and a failed refresh above all', () => {
    expect(viewStatusFor({ ...base, counts: { usr_me: 1 } }, 'usr_me', 62 * MIN)).toBe('needs_you');
    expect(viewStatusFor({ ...base, counts: { usr_me: 1 } }, 'usr_you', 10 * MIN)).toBe('ok');
    expect(viewStatusFor({ ...base, counts: 2, failed: true }, 'usr_me', 0)).toBe('failed');
  });
});

describe('viewNextDueMs', () => {
  it('agrees with isViewRefreshDue across data ages, last tries and times', () => {
    const everyMs = 3_600_000;
    const times = [null, 0, 1_000, 5_000_000, 10_000_000, 20_000_000];
    for (const dataModifiedMs of times) {
      for (const lastStartedMs of times) {
        for (const now of [0, 999, 3_600_000, 3_601_000, 7_000_000, 9_999_999, 10_000_000, 13_600_000, 30_000_000]) {
          const spec = { everyMs, dataModifiedMs, lastStartedMs };
          expect(isViewRefreshDue({ ...spec, now })).toBe(now >= viewNextDueMs(spec));
        }
      }
    }
  });
  it('counts from the last pass, not from data a button press rewrote since', () => {
    const everyMs = 86_400_000;
    // Pass at 0; a Rewrite press rewrote the data 20 hours later.
    const spec = { everyMs, lastStartedMs: 0, dataModifiedMs: 72_000_000 };
    expect(viewNextDueMs(spec)).toBe(everyMs);
    expect(isViewRefreshDue({ ...spec, now: everyMs })).toBe(true);
  });
  it('falls back to the data file while no pass is on record', () => {
    expect(viewNextDueMs({ everyMs: 60_000, dataModifiedMs: 5_000, lastStartedMs: null })).toBe(65_000);
  });
  it('is 0 for a view that was never written or tried', () => {
    expect(viewNextDueMs({ everyMs: 60_000, dataModifiedMs: null, lastStartedMs: null })).toBe(0);
  });
});

describe('viewScheduleSignature', () => {
  it('is the same for the same interval and refresh words, whatever else view.json holds', () => {
    const a = parseViewSchedule(JSON.stringify({ every: '1h', runs_as: 'usr_a', refresh: 'Draft.' }))!;
    const b = parseViewSchedule(
      JSON.stringify({ every: '60m', runs_as: 'usr_a', refresh: 'Draft.', title: 'Renamed', order: 4 })
    )!;
    expect(viewScheduleSignature(a)).toBe(viewScheduleSignature(b));
  });
  it('changes with the interval or the refresh words', () => {
    const base = { everyMs: 3_600_000, refresh: 'Draft.' };
    expect(viewScheduleSignature({ ...base, everyMs: 300_000 })).not.toBe(viewScheduleSignature(base));
    expect(viewScheduleSignature({ ...base, refresh: 'Send it all.' })).not.toBe(viewScheduleSignature(base));
    expect(viewScheduleSignature({ ...base, refresh: null })).not.toBe(viewScheduleSignature(base));
  });
});

describe('a schedule at a set time', () => {
  const DAY = 86_400_000;
  const NY = 'America/New_York';
  const schedule = (meta: object) => parseViewSchedule(JSON.stringify({ runs_as: 'usr_a', ...meta }));
  const friday3pm = schedule({ at: 'fri 15:00', tz: NY })!.at!;

  it('reads a day and a time, in a zone, with a week as its period', () => {
    expect(schedule({ at: 'fri 15:00', tz: NY })).toEqual({
      everyMs: 7 * DAY,
      at: { days: [5], minute: 15 * 60, tz: NY, fromMs: null },
      runsAs: 'usr_a',
      refresh: null,
    });
  });
  it('reads a time with no day as every day, in the zone of the Mac that runs it', () => {
    expect(schedule({ at: '9:30' })).toMatchObject({
      everyMs: DAY,
      at: { days: null, minute: 9 * 60 + 30, tz: null },
    });
  });
  it('reads the ways a day and a time get written', () => {
    expect(schedule({ at: 'every Friday at 3pm', tz: NY })?.at).toEqual(friday3pm);
    expect(schedule({ at: 'Fridays 3:00 PM', tz: NY })?.at).toEqual(friday3pm);
    expect(schedule({ at: 'mon,wed,fri 09:00' })).toMatchObject({ everyMs: 3 * DAY, at: { days: [1, 3, 5] } });
    expect(schedule({ at: 'weekdays 09:00' })).toMatchObject({ everyMs: 3 * DAY, at: { days: [1, 2, 3, 4, 5] } });
    expect(schedule({ at: 'daily 12am' })?.at).toMatchObject({ days: null, minute: 0 });
  });
  it('is no schedule when the time, a day or the zone cannot be read, even with an interval beside it', () => {
    expect(schedule({ at: 'soon', every: '1h' })).toBeNull();
    expect(schedule({ at: 'fri 25:00' })).toBeNull();
    expect(schedule({ at: 'someday 15:00' })).toBeNull();
    expect(schedule({ at: 'fri 15:00', tz: 'Mars/Olympus' })).toBeNull();
    expect(schedule({ at: 'fri 15:00', from: 'next week' })).toBeNull();
    expect(parseViewSchedule(JSON.stringify({ at: 'fri 15:00' }))).toBeNull();
  });
  it('comes up the next time that day and hour arrive in its zone', () => {
    // Set on Friday 2026-11-20 at 18:25 in New York (UTC-5): next is Friday the 27th at 15:00 there.
    expect(viewAtNextMs(friday3pm, Date.UTC(2026, 10, 20, 23, 25))).toBe(Date.UTC(2026, 10, 27, 20, 0));
    // That Friday morning, it is the same afternoon; at 15:00 sharp, the week after.
    expect(viewAtNextMs(friday3pm, Date.UTC(2026, 10, 20, 15, 0))).toBe(Date.UTC(2026, 10, 20, 20, 0));
    expect(viewAtNextMs(friday3pm, Date.UTC(2026, 10, 20, 20, 0))).toBe(Date.UTC(2026, 10, 27, 20, 0));
  });
  it('keeps the hour on the wall when the clocks change', () => {
    // New York goes to UTC-4 on 2027-03-14: 15:00 is 20:00 UTC on the 12th and 19:00 UTC on the 19th.
    expect(viewAtNextMs(friday3pm, Date.UTC(2027, 2, 12, 20, 0))).toBe(Date.UTC(2027, 2, 19, 19, 0));
  });
  it('does not come up before the day it starts from', () => {
    const later = schedule({ at: 'fri 15:00', tz: NY, from: '2026-11-27' })!.at!;
    // Set on Wednesday the 18th: Friday the 20th is skipped.
    expect(viewAtNextMs(later, Date.UTC(2026, 10, 18, 17, 0))).toBe(Date.UTC(2026, 10, 27, 20, 0));
    expect(viewNextDueMs({ everyMs: 7 * DAY, at: later, dataModifiedMs: null, lastStartedMs: null })).toBe(
      Date.UTC(2026, 10, 27, 20, 0)
    );
  });
  it('is due at its time, stays due when the time was missed, and then waits for the next', () => {
    const spec = { everyMs: 7 * DAY, at: friday3pm, dataModifiedMs: Date.UTC(2026, 10, 20, 23, 25) };
    const first = Date.UTC(2026, 10, 27, 20, 0);
    expect(viewNextDueMs({ ...spec, lastStartedMs: null })).toBe(first);
    expect(isViewRefreshDue({ ...spec, lastStartedMs: null, now: first - 1 })).toBe(false);
    expect(isViewRefreshDue({ ...spec, lastStartedMs: null, now: first })).toBe(true);
    // The app was closed on Friday December 4: it runs when opened on Saturday, then waits for the 11th.
    const saturday = Date.UTC(2026, 11, 5, 18, 0);
    expect(isViewRefreshDue({ ...spec, lastStartedMs: first, now: saturday })).toBe(true);
    expect(viewNextDueMs({ ...spec, lastStartedMs: saturday })).toBe(Date.UTC(2026, 11, 11, 20, 0));
  });
  it('is due at once when it was never written or tried and has no start day', () => {
    expect(viewNextDueMs({ everyMs: 7 * DAY, at: friday3pm, dataModifiedMs: null, lastStartedMs: null })).toBe(0);
  });
  it('is a new agreement when its time, day or zone changes, and leaves an interval\'s as it was', () => {
    const sign = (meta: object) => viewScheduleSignature(schedule({ refresh: 'Draft.', ...meta })!);
    const base = sign({ at: 'fri 15:00', tz: NY });
    expect(sign({ at: 'Friday 3pm', tz: NY, title: 'Renamed' })).toBe(base);
    expect(sign({ at: 'fri 16:00', tz: NY })).not.toBe(base);
    expect(sign({ at: 'thu 15:00', tz: NY })).not.toBe(base);
    expect(sign({ at: 'fri 15:00', tz: 'Europe/Paris' })).not.toBe(base);
    expect(sign({ every: '1h' })).toBe('3600000\nDraft.');
  });
  it('shows in the manifest', () => {
    const manifest = readViewManifest({
      name: 'support',
      meta: JSON.stringify({ at: 'fri 15:00', tz: NY, runs_as: 'usr_a' }),
      data: null,
      dataModifiedMs: null,
    });
    expect(manifest.at).toEqual(friday3pm);
    expect(manifest.everyMs).toBe(7 * DAY);
  });
});

describe('viewMetasWrittenBy', () => {
  const whole = JSON.stringify({ title: 'Drafts', every: '1h', runs_as: 'usr_a', refresh: 'Draft.' });
  it('names the view.json a file tool wrote, with the schedule when the diff holds the whole file', () => {
    expect(
      viewMetasWrittenBy({
        content: [{ type: 'diff', path: '/spaces/one/views/drafts/view.json', newText: whole }],
      })
    ).toEqual([{ view: 'drafts', schedule: { everyMs: 3_600_000, at: null, runsAs: 'usr_a', refresh: 'Draft.' } }]);
  });
  it('gives no schedule when the diff holds only the changed part', () => {
    expect(
      viewMetasWrittenBy({
        content: [{ type: 'diff', path: 'views/inbox/view.json', oldText: '"1h"', newText: '"30m"' }],
      })
    ).toEqual([{ view: 'inbox', schedule: null }]);
  });
  it('ignores reads, shell commands and other files', () => {
    expect(viewMetasWrittenBy({ kind: 'read', locations: [{ path: 'views/drafts/view.json' }] })).toEqual([]);
    expect(
      viewMetasWrittenBy({ kind: 'execute', rawInput: { command: 'cat views/drafts/view.json' } })
    ).toEqual([]);
    expect(
      viewMetasWrittenBy({ content: [{ type: 'content', content: { text: 'views/drafts/view.json' } }] })
    ).toEqual([]);
    expect(
      viewMetasWrittenBy({ content: [{ type: 'diff', path: 'views/drafts/data.json', newText: whole }] })
    ).toEqual([]);
    expect(
      viewMetasWrittenBy({ content: [{ type: 'diff', path: 'previews/drafts/view.json', newText: whole }] })
    ).toEqual([]);
  });
});

describe('viewMessageHasGesture', () => {
  it('is true only when the browser says the person just pressed or typed', () => {
    expect(viewMessageHasGesture({ userActivation: { isActive: true } })).toBe(true);
    expect(viewMessageHasGesture({ userActivation: { isActive: false } })).toBe(false);
    expect(viewMessageHasGesture({ userActivation: null })).toBe(false);
    expect(viewMessageHasGesture({})).toBe(false);
  });
});

describe('viewOfRefreshPrompt', () => {
  it('reads back the view a scheduled refresh names', () => {
    const prompt = viewRefreshPrompt('drafts', { everyMs: 3_600_000, runsAs: 'usr_a', refresh: 'Draft.' });
    expect(viewOfRefreshPrompt(prompt)).toBe('drafts');
    expect(viewOfRefreshPrompt(viewRefreshPrompt('prs', { everyMs: 1, runsAs: 'usr_a', refresh: null }))).toBe('prs');
  });
  it('is null for any other run', () => {
    expect(viewOfRefreshPrompt('From the "drafts" view, Sam chose "approve".')).toBeNull();
    expect(viewOfRefreshPrompt('@claude Scheduled refresh of the "drafts" view.')).toBeNull();
    expect(viewOfRefreshPrompt('Scheduled refresh of the "../x" view.')).toBeNull();
  });
});
