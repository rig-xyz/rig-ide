import { describe, expect, it } from 'vitest';
import type { RawSessionEvent } from '../spaces/dispatch';
import { createOwnChatWrites } from './own-chat-writes';

const viewJson = (meta: object) => JSON.stringify({ runs_as: 'usr_me', ...meta });
const wrote = (path: string, newText: string, sessionUpdate = 'tool_call_update'): RawSessionEvent => ({
  kind: 'acp_update',
  sessionId: 's1',
  update: { sessionUpdate, content: [{ type: 'diff', path, newText }] },
});

function setup(over: { bindingOf?: (cwd: string) => string | null; failFirst?: number } = {}) {
  const marks: [string, string, string | null][] = [];
  const listeners = new Map<string, (event: RawSessionEvent) => void>();
  const stopped: string[] = [];
  let failures = over.failFirst ?? 0;
  const watcher = createOwnChatWrites({
    bindingOf: over.bindingOf ?? ((cwd) => (cwd.startsWith('/Rig/launch') ? 'bnd_1' : null)),
    subscribeRaw: async (conversationId, on) => {
      if (failures-- > 0) throw new Error('no such session yet');
      listeners.set(conversationId, on);
      return () => stopped.push(conversationId);
    },
    mark: (bindingId, view, signature) => marks.push([bindingId, view, signature]),
    sleep: async () => {},
  });
  const emit = (conversationId: string, event: RawSessionEvent) => listeners.get(conversationId)?.(event);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { watcher, marks, emit, stopped, listeners, settled };
}

describe('schedules a chat session of yours writes in a space', () => {
  it("marks a view.json the session's own file tool wrote, with the schedule it put there", async () => {
    const t = setup();
    t.watcher.started({ conversationId: 'c1', cwd: '/Rig/launch', projectId: 'rig' });
    await t.settled();
    t.emit('c1', wrote('/Rig/launch/views/check/view.json', viewJson({ at: 'fri 15:00', tz: 'America/New_York', refresh: 'Check.' })));
    expect(t.marks).toHaveLength(1);
    expect(t.marks[0]!.slice(0, 2)).toEqual(['bnd_1', 'check']);
    expect(t.marks[0]![2]).toContain('Check.');
    // A part of the file only: the view is marked, with no schedule to hold it to.
    t.emit('c1', wrote('/Rig/launch/views/check/view.json', '"every": "1h"'));
    expect(t.marks[1]).toEqual(['bnd_1', 'check', null]);
  });

  it('ignores other files, reads and words', async () => {
    const t = setup();
    t.watcher.started({ conversationId: 'c1', cwd: '/Rig/launch' });
    await t.settled();
    t.emit('c1', wrote('/Rig/launch/views/check/data.json', '{}'));
    t.emit('c1', wrote('/Rig/launch/views/check/view.json', viewJson({ every: '1h' }), 'agent_message_chunk'));
    t.emit('c1', { kind: 'turn_end', turnId: 't', stopReason: 'end_turn' });
    expect(t.marks).toEqual([]);
  });

  it('follows only a session in a space on this Mac, and never a Room run, which reports its own', async () => {
    const t = setup();
    t.watcher.started({ conversationId: 'home', cwd: '/userData/home-chat' });
    t.watcher.started({ conversationId: 'run', cwd: '/Rig/launch', projectId: 'space' });
    t.watcher.started({ conversationId: 'nowhere', cwd: null });
    await t.settled();
    expect([...t.listeners.keys()]).toEqual([]);
  });

  it('waits for a session that is not there yet, and stops following one that ended', async () => {
    const t = setup({ failFirst: 2 });
    t.watcher.started({ conversationId: 'c1', cwd: '/Rig/launch' });
    await t.settled();
    t.emit('c1', wrote('/Rig/launch/views/check/view.json', viewJson({ every: '1h' })));
    expect(t.marks).toHaveLength(1);
    t.watcher.ended('c1');
    expect(t.stopped).toEqual(['c1']);
    // Resumed: followed again, once.
    t.watcher.started({ conversationId: 'c1', cwd: '/Rig/launch' });
    t.watcher.started({ conversationId: 'c1', cwd: '/Rig/launch' });
    await t.settled();
    expect(t.stopped).toEqual(['c1']);
  });
});
