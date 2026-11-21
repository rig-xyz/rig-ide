import { describe, expect, it } from 'vitest';
import { homeCommand, matchHomeCommands } from './home-commands';

describe("commands in Home's chat", () => {
  it('a command is the whole message, whatever its case; inside a sentence it is words', () => {
    expect(homeCommand('/new')).toBe('new');
    expect(homeCommand('  /Compact ')).toBe('compact');
    expect(homeCommand('/stop')).toBe('stop');
    expect(homeCommand('start a /new thing')).toBeNull();
    expect(homeCommand('/new space please')).toBeNull();
    expect(homeCommand('/status')).toBeNull();
  });

  it('"/clear" starts a new conversation too', () => {
    expect(homeCommand('/clear')).toBe('new');
  });

  it('the menu lists every command for a bare slash, and finds one by the start of either name', () => {
    expect(matchHomeCommands('').map((c) => c.cmd)).toEqual(['/new', '/compact', '/stop']);
    expect(matchHomeCommands('co').map((c) => c.cmd)).toEqual(['/compact']);
    expect(matchHomeCommands('cl').map((c) => c.cmd)).toEqual(['/new']);
    expect(matchHomeCommands('x')).toEqual([]);
  });
});
