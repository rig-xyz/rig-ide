import { describe, expect, it } from 'vitest';
import {
  readingNow,
  readsNow,
  SOURCE_FOR,
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

describe('watchWrites', () => {
  it('turning on a tool with no source adds one', () => {
    expect(watchWrites([slack], 'linear', true)).toEqual({ add: SOURCE_FOR.linear, pause: [] });
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
