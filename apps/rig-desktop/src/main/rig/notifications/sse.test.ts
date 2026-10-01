import { describe, expect, it } from 'vitest';
import { parseSse } from './sse';

describe('parseSse', () => {
  it('splits complete events and keeps the unfinished tail', () => {
    const { events, rest } = parseSse('event: notification\ndata: {"id":"1"}\n\nevent: heartbeat\ndata: {}\n\nevent: rea');
    expect(events).toEqual([
      { event: 'notification', data: '{"id":"1"}' },
      { event: 'heartbeat', data: '{}' },
    ]);
    expect(rest).toBe('event: rea');
  });

  it('handles CRLF, comments, multi-line data and a missing space after the colon', () => {
    const { events } = parseSse(': hi\r\nevent:read\r\ndata:a\r\ndata: b\r\n\r\n');
    expect(events).toEqual([{ event: 'read', data: 'a\nb' }]);
  });

  it('reassembles an event split across chunks', () => {
    let buffer = '';
    const out: string[] = [];
    for (const chunk of ['event: notif', 'ication\ndata: {"id"', ':"2"}\n', '\n']) {
      const parsed = parseSse(buffer + chunk);
      buffer = parsed.rest;
      out.push(...parsed.events.map((e) => `${e.event}:${e.data}`));
    }
    expect(out).toEqual(['notification:{"id":"2"}']);
  });
});
