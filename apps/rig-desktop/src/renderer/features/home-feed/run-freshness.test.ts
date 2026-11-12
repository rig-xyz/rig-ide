import { describe, expect, it } from 'vitest';
import { feedFreshness, type RunRow } from './run-freshness';

const row = (over: Partial<RunRow>): RunRow => ({ ref: 'run_x', title: 'Read Slack and Linear.', at: '2026-11-11T20:00:00Z', ended: '2026-11-11T20:01:00Z', read: [{ source: 'slack', until: '2026-11-11T20:00:00Z' }], changed: 0, ...over });

describe('the Feed header’s last check', () => {
  it('is fresh when the latest run that ended read, with its note', () => {
    expect(feedFreshness([row({ changed: 2 })])).toEqual({ kind: 'fresh', at: Date.parse('2026-11-11T20:01:00Z'), sources: ['slack'], changed: 2 });
  });

  it('never takes a run that read nothing for a check, though its row keeps the old cursors', () => {
    const runs = [
      row({ ref: 'run_3', title: 'The run failed: Prompt is too long', ended: '2026-11-11T20:51:00Z' }),
      row({ ref: 'run_2', title: "The run ended without a note. Claude's last words: I'm still paused", ended: '2026-11-08T10:00:00Z' }),
      row({ ref: 'run_1', title: 'Read Slack, Linear and GitHub.', ended: '2026-11-06T04:05:00Z', read: [{ source: 'slack', until: 'x' }, { source: 'linear', until: 'y' }] }),
    ];
    expect(feedFreshness(runs)).toEqual({
      kind: 'failing',
      tried: Date.parse('2026-11-11T20:51:00Z'),
      why: 'Prompt is too long',
      lastRead: { at: Date.parse('2026-11-06T04:05:00Z'), sources: ['slack', 'linear'] },
    });
  });

  it('says a note-less run read nothing, and has no last read when none of the rows has one', () => {
    const r = feedFreshness([row({ title: "The run ended without a note. Claude's last words: (none)" })]);
    expect(r).toMatchObject({ kind: 'failing', why: 'Claude ended it without reading anything', lastRead: null });
  });

  it('skips a run still going, and says never when none has ended', () => {
    expect(feedFreshness([row({ ended: null })])).toEqual({ kind: 'never' });
    expect(feedFreshness([row({ ref: 'run_now', ended: null, read: [] }), row({ ref: 'run_prev' })])).toMatchObject({ kind: 'fresh' });
  });
});
