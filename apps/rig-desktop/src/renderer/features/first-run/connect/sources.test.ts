import { describe, expect, it } from 'vitest';
import {
  readingNow,
  readsNow,
  sourceFor,
  watchingFrom,
  watchWrites,
  type SourceRow,
} from './sources';

const slack: SourceRow = { ref: 'src_slack', connector: 'Slack', paused: false };
const calendar: SourceRow = {
  ref: 'src_google-calendar',
  connector: 'Google Calendar',
  paused: true,
};

describe('watchingFrom', () => {
  it('a running source is watched, an all-paused one left out, and a tool with none absent', () => {
    expect(watchingFrom([slack, calendar])).toEqual({ slack: true, calendar: false });
  });

  it('any running source of a tool keeps it watched', () => {
    expect(
      watchingFrom([
        { ...slack, paused: true },
        { ...slack, ref: 'src_slack-2' },
      ])
    ).toEqual({
      slack: true,
    });
  });
});

describe('a tool Rig has no words for', () => {
  it("is a source under Claude's own name, read for what waits on the person", () => {
    expect(watchWrites([slack], 'Google Drive', true).add).toEqual({
      connector: 'Google Drive',
      what: 'what changed that involves you, and what waits on you',
    });
  });

  it('keeps its choice under its name, whatever its case', () => {
    const drive: SourceRow = { ref: 'src_drive', connector: 'Google Drive', paused: true };
    expect(watchingFrom([drive])).toEqual({ 'google drive': false });
    expect(watchWrites([drive], 'google drive', true).pause).toEqual([{ ref: 'src_drive', paused: false }]);
  });

  it("is the same switch as a known tool's source under another name", () => {
    // Claude lists "Google Calendar"; an older source says "Calendar".
    const old: SourceRow = { ref: 'src_cal', connector: 'Calendar', paused: false };
    expect(watchWrites([old], 'Google Calendar', false).pause).toEqual([{ ref: 'src_cal', paused: true }]);
  });
});

describe('watchWrites', () => {
  it('turning on a tool with no source adds one', () => {
    expect(watchWrites([slack], 'Linear', true)).toEqual({ add: sourceFor('Linear'), pause: [] });
  });

  it('turning on a paused tool resumes it rather than adding a second', () => {
    expect(watchWrites([calendar], 'calendar', true)).toEqual({
      add: null,
      pause: [{ ref: 'src_google-calendar', paused: false }],
    });
  });

  it('turning off pauses what runs, and is nothing for a tool with no source', () => {
    expect(watchWrites([slack], 'slack', false)).toEqual({
      add: null,
      pause: [{ ref: 'src_slack', paused: true }],
    });
    expect(watchWrites([slack], 'notion', false)).toEqual({ add: null, pause: [] });
  });

  it('turning on a tool that already runs writes nothing', () => {
    expect(watchWrites([slack], 'slack', true)).toEqual({ add: null, pause: [] });
  });
});

describe('readsNow', () => {
  it('what runs now for someone Rig reads for: their sources, or the defaults with none', () => {
    expect(readsNow({}, 'slack')).toBe(true);
    expect(readsNow({}, 'gmail')).toBe(false);
    expect(readsNow({ gmail: true, slack: false }, 'gmail')).toBe(true);
    expect(readsNow({ gmail: true, slack: false }, 'slack')).toBe(false);
    expect(readsNow({ gmail: true }, 'linear')).toBe(false);
  });

  it('flipping one switch keeps the defaults that were on', () => {
    expect(readingNow({})).toEqual({ slack: true, linear: true, github: true });
    expect(readingNow({ gmail: true })).toEqual({ gmail: true });
  });
});
