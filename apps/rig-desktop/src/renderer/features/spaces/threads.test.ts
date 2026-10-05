import { describe, expect, it } from 'vitest';
import type { TranscriptFocus } from './components/room-transcript';
import { buildThreads, focusForThreads, newestSeq, summarizeThread, threadRootFor } from './threads';
import type { RoomMessage, SessionRunMeta } from './types';

let seq = 0;
function text(id: string, authorId: string, replyTo?: string, extra: { alsoInChannel?: boolean; sending?: true } = {}): RoomMessage {
  seq += 1;
  return {
    id,
    seq,
    authorId,
    createdAt: `2026-10-05T10:${String(seq).padStart(2, '0')}:00Z`,
    time: `10:${String(seq).padStart(2, '0')}`,
    body: id,
    meta: {
      kind: 'text',
      ...(replyTo ? { replyTo: { id: replyTo, authorId: 'x', label: 'X', excerpt: '…' } } : {}),
      ...(extra.alsoInChannel ? { alsoInChannel: true } : {}),
    },
    ...(extra.sending ? { sending: true as const } : {}),
  };
}

function run(id: string, runId: string, owner: string, sourceMessageId?: string): RoomMessage {
  seq += 1;
  return {
    id,
    seq,
    authorId: owner,
    createdAt: `2026-10-05T10:${String(seq).padStart(2, '0')}:00Z`,
    time: `10:${String(seq).padStart(2, '0')}`,
    body: 'prompt',
    meta: { kind: 'session', runId, ...(sourceMessageId ? { sourceMessageId } : {}) },
  };
}

const ids = (messages: readonly RoomMessage[]) => messages.map((m) => m.id);

describe('buildThreads', () => {
  it('keeps roots in the main column and folds their replies under them, in order', () => {
    const messages = [text('a', 'sam'), text('a1', 'kim', 'a'), text('b', 'kim'), text('a2', 'me', 'a')];
    const layout = buildThreads(messages);
    expect(ids(layout.main)).toEqual(['a', 'b']);
    expect(ids(layout.threads.get('a')!.replies)).toEqual(['a1', 'a2']);
    expect(layout.threads.has('b')).toBe(false);
    expect(layout.rootOf.get('a2')).toBe('a');
    expect([...layout.roots]).toEqual(['a', 'b']);
  });

  it('flattens a reply to a reply into its root thread', () => {
    const layout = buildThreads([text('a', 'sam'), text('a1', 'kim', 'a'), text('a1x', 'me', 'a1'), text('a1xy', 'sam', 'a1x')]);
    expect(ids(layout.main)).toEqual(['a']);
    expect(ids(layout.threads.get('a')!.replies)).toEqual(['a1', 'a1x', 'a1xy']);
    expect(threadRootFor(layout, 'a1xy')).toBe('a');
    expect(threadRootFor(layout, 'a')).toBe('a');
  });

  it("shows a reply whose root isn't loaded in the main column, as Flow does, and so are replies to it", () => {
    const layout = buildThreads([text('r1', 'kim', 'gone'), text('r2', 'me', 'r1'), text('b', 'kim')]);
    expect(ids(layout.main)).toEqual(['r1', 'r2', 'b']);
    expect(layout.threads.size).toBe(0);
    // Not a thread you can open from here: its root isn't loaded.
    expect(threadRootFor(layout, 'r1')).toBeNull();
  });

  it('once the root comes in with an older page, the reply folds under it', () => {
    const root = text('root', 'sam');
    const reply = text('r1', 'kim', 'root');
    expect(ids(buildThreads([reply]).main)).toEqual(['r1']);
    expect(ids(buildThreads([root, reply]).main)).toEqual(['root']);
  });

  it('a reply also sent to the main column shows in both places', () => {
    const layout = buildThreads([text('a', 'sam'), text('a1', 'me', 'a', { alsoInChannel: true }), text('a2', 'kim', 'a')]);
    expect(ids(layout.main)).toEqual(['a', 'a1']);
    expect(ids(layout.threads.get('a')!.replies)).toEqual(['a1', 'a2']);
    // Reply on it opens its thread.
    expect(threadRootFor(layout, 'a1')).toBe('a');
  });

  it('a run asked from a thread reply belongs to that thread; asked from a root, or with no source, it stays in the main column', () => {
    const layout = buildThreads([
      text('a', 'sam'),
      text('a1', 'me', 'a'),
      run('s1', 'run-1', 'me', 'a1'),
      text('b', 'me'),
      run('s2', 'run-2', 'me', 'b'),
      run('s3', 'run-3', 'kim'),
      text('s3r', 'sam', 's3'),
    ]);
    expect(ids(layout.main)).toEqual(['a', 'b', 's2', 's3']);
    expect(ids(layout.threads.get('a')!.replies)).toEqual(['a1', 's1']);
    // A run in the main column starts its own thread when someone replies to it.
    expect(ids(layout.threads.get('s3')!.replies)).toEqual(['s3r']);
  });

  it('a run asked from a reply whose root is not loaded stays in the main column', () => {
    const layout = buildThreads([text('r1', 'me', 'gone'), run('s1', 'run-1', 'me', 'r1')]);
    expect(ids(layout.main)).toEqual(['r1', 's1']);
  });

  it('never loops on a reply cycle', () => {
    const a = text('a', 'sam', 'b');
    const b = text('b', 'kim', 'a');
    expect(ids(buildThreads([a, b]).main)).toEqual(['a', 'b']);
  });

  it('places your sending reply in its thread right away', () => {
    const layout = buildThreads([text('a', 'sam'), text('sending-1', 'me', 'a', { sending: true })]);
    expect(ids(layout.main)).toEqual(['a']);
    expect(ids(layout.threads.get('a')!.replies)).toEqual(['sending-1']);
  });
});

describe('summarizeThread', () => {
  const meta = (id: string, owner: string): SessionRunMeta => ({
    id,
    agent: 'claude',
    owner,
    model: '',
    title: '',
    status: 'running',
    startedAt: '2026-10-05T10:00:00Z',
    endedAt: null,
  });

  it('counts replies, shows up to three repliers newest first, and the last one', () => {
    const layout = buildThreads([
      text('a', 'sam'),
      text('a1', 'kim', 'a'),
      text('a2', 'lee', 'a'),
      text('a3', 'kim', 'a'),
      text('a4', 'ana', 'a'),
      text('a5', 'me', 'a'),
    ]);
    const summary = summarizeThread(layout.threads.get('a')!, { sessionMetaByRun: {} }, 'me', null, () => false);
    expect(summary.count).toBe(5);
    expect(summary.faces).toEqual([
      { kind: 'person', id: 'me' },
      { kind: 'person', id: 'ana' },
      { kind: 'person', id: 'kim' },
    ]);
    expect(summary.last.id).toBe('a5');
    expect(summary.working).toBeNull();
  });

  it('counts unread replies from others past what you saw, never your own or one still sending', () => {
    const messages = [text('a', 'sam'), text('a1', 'kim', 'a'), text('a2', 'me', 'a'), text('a3', 'kim', 'a'), text('a4', 'me', 'a', { sending: true })];
    const thread = buildThreads(messages).threads.get('a')!;
    expect(summarizeThread(thread, { sessionMetaByRun: {} }, 'me', null, () => false).unread).toBe(2);
    expect(summarizeThread(thread, { sessionMetaByRun: {} }, 'me', messages[1]!.seq, () => false).unread).toBe(1);
    expect(summarizeThread(thread, { sessionMetaByRun: {} }, 'me', newestSeq(thread), () => false).unread).toBe(0);
    expect(newestSeq(thread)).toBe(messages[3]!.seq);
  });

  it('says an agent is working while a run in the thread is live, and shows it as a face', () => {
    const thread = buildThreads([text('a', 'sam'), text('a1', 'me', 'a'), run('s1', 'run-1', 'me', 'a1')]).threads.get('a')!;
    const snapshot = { sessionMetaByRun: { 'run-1': meta('run-1', 'me') } };
    const live = summarizeThread(thread, snapshot, 'me', null, (id) => id === 'run-1');
    expect(live.working).toBe('claude');
    expect(live.faces[0]).toEqual({ kind: 'agent', agent: 'claude', owner: 'me' });
    expect(summarizeThread(thread, snapshot, 'me', null, () => false).working).toBeNull();
  });
});

describe('focusForThreads', () => {
  const layout = buildThreads([text('a', 'sam'), text('a1', 'kim', 'a'), text('b', 'kim'), text('b1', 'me', 'b', { alsoInChannel: true }), text('c', 'sam')]);
  const base = (messageIds: string[], extra: Partial<TranscriptFocus> = {}): TranscriptFocus => ({
    messageIds: new Set(messageIds),
    foldLabel: (n) => `${n}`,
    ...extra,
  });

  it("a topic applies to roots: a reply's own topic doesn't pull its root in", () => {
    expect([...focusForThreads(base(['a1', 'c']), layout)!.messageIds]).toEqual(['c']);
    expect([...focusForThreads(base(['a', 'a1']), layout)!.messageIds]).toEqual(['a']);
    // Also sent to the main column: it's there, so its topic counts.
    expect([...focusForThreads(base(['b1']), layout)!.messageIds]).toEqual(['b1']);
  });

  it('an ask of you inside a thread raises its root, whose Done answers that ask', () => {
    const answered: string[] = [];
    const focus = focusForThreads(
      base(['a1', 'c'], { askIds: new Set(['a1']), order: 'asks-first', askAccessory: (id) => (answered.push(id), null) }),
      layout
    )!;
    expect([...focus.askIds!]).toEqual(['a']);
    expect(focus.messageIds.has('a')).toBe(true);
    void focus.askAccessory!('a');
    void focus.askAccessory!('c');
    expect(answered).toEqual(['a1', 'c']);
  });

  it('no focus stays no focus', () => {
    expect(focusForThreads(undefined, layout)).toBeUndefined();
  });
});
