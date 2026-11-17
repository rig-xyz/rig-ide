import { describe, expect, it } from 'vitest';
import { matchRoomCommands, roomCommand, sideChatText, statusLines } from './room-commands';

describe('roomCommand', () => {
  it('is the whole message only', () => {
    expect(roomCommand('/new', true)).toBe('new');
    expect(roomCommand('  /New-Session ', true)).toBe('new');
    expect(roomCommand('/stop', true)).toBe('stop');
    expect(roomCommand('/status', true)).toBe('status');
    expect(roomCommand('/new please', true)).toBeNull();
    expect(roomCommand('try /new', true)).toBeNull();
    expect(roomCommand('/rig-views', true)).toBeNull();
  });
});

describe('sideChatText', () => {
  it('takes what follows /side as the side chat\'s first message', () => {
    expect(roomCommand('/side draft the reply to Ana', true)).toBe('side');
    expect(sideChatText('/side draft the reply to Ana')).toBe('draft the reply to Ana');
    expect(sideChatText('/side\nfirst line\nsecond line')).toBe('first line\nsecond line');
  });
  it('opens an empty side chat with no words', () => {
    expect(roomCommand('/side', true)).toBe('side');
    expect(sideChatText(' /SIDE ')).toBe('');
  });
  it('is not a side chat inside a sentence or as part of a longer word', () => {
    expect(sideChatText('try /side later')).toBeNull();
    expect(sideChatText('/sidebar is broken')).toBeNull();
    expect(roomCommand('/sidebar is broken', true)).toBeNull();
  });
});

describe('matchRoomCommands', () => {
  it('matches by what follows the slash', () => {
    expect(matchRoomCommands('', true).map((c) => c.cmd)).toEqual(['/new', '/stop', '/status', '/side']);
    expect(matchRoomCommands('st', true).map((c) => c.cmd)).toEqual(['/stop', '/status']);
    expect(matchRoomCommands('x', true)).toEqual([]);
  });

  it('leaves side chats out without Rig Alpha: "/side" is then a message like any other', () => {
    expect(matchRoomCommands('', false).map((c) => c.cmd)).toEqual(['/new', '/stop', '/status']);
    expect(roomCommand('/side', false)).toBeNull();
    expect(roomCommand('/side draft the reply to Ana', false)).toBeNull();
    expect(roomCommand('/stop', false)).toBe('stop');
  });
});

describe('statusLines', () => {
  const names = { claude: 'Claude', codex: 'Codex' };
  const now = 10 * 60 * 60_000;
  it('says each session in a line', () => {
    expect(
      statusLines(
        [
          { agent: 'claude', working: true, contextTokens: 84_300, lastTurnAt: now - 60_000 },
          { agent: 'codex', working: false, contextTokens: null, lastTurnAt: now - 3 * 60_000 },
        ],
        names,
        now
      )
    ).toEqual(['Claude: working · 84k tokens in its session', 'Codex: idle · last turn 3 min ago']);
  });
  it('says when there is none', () => {
    expect(statusLines([], names, now)).toEqual(['No session yet. Your next message starts one.']);
  });
});
