import { describe, expect, it } from 'vitest';
import { roomTextMessage } from './room-send';

describe('roomTextMessage', () => {
  it('a plain message has no meta', () => {
    expect(roomTextMessage('hello')).toEqual({ body: 'hello', kind: 'text' });
  });

  it('a reply carries what it answers, the way the Room sends one', () => {
    const replyTo = { id: 'm1', authorId: 'u_hugo', label: 'Hugo', excerpt: 'wdyt' };
    expect(roomTextMessage('yes, ship it', replyTo)).toEqual({ body: 'yes, ship it', kind: 'text', meta: { replyTo } });
  });

  it('keeps the rest of the Room composer meta', () => {
    expect(
      roomTextMessage('hi', undefined, 'claude', {
        clientId: 'c1',
        route: 'none',
        alsoInChannel: true,
        mentions: [{ id: 'u_ana', name: 'Ana' }],
      })
    ).toEqual({
      body: 'hi',
      kind: 'text',
      meta: { asks: 'claude', clientId: 'c1', alsoInChannel: true, route: 'none', mentions: ['u_ana'], mentionNames: ['Ana'] },
    });
  });
});
