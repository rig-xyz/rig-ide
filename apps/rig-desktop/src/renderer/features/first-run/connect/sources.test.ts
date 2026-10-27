import { describe, expect, it } from 'vitest';
import { SOURCE_FOR, watchingFrom, watchWrites, type SourceRow } from './sources';

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
