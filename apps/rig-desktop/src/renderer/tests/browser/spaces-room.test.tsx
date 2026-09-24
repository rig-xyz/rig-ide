import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '@renderer/features/spaces/components/composer';
import { groupThreads, RoomTranscript } from '@renderer/features/spaces/components/room-transcript';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import { buildRoomFeed } from '@renderer/features/spaces/fixtures/room-feed';
import { FixtureRoomSource } from '@renderer/features/spaces/room-source';
import type { RoomMember, RoomMessage, RoomSnapshot, SessionEvent, SessionRunMeta } from '@renderer/features/spaces/types';
// Real tokens — the message-bubble/session-card class assertions below rely
// on the actual `--accent`/`--bg-2` etc. custom properties being present,
// same as artifact-view.test.tsx.
import '@renderer/tokens.css';

// The session card renders answers with SafeMarkdown, which imports the IPC
// bridge (for opening links); nothing here clicks a link.
vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal: async () => {} } } }));

/**
 * Spaces (lane 2): renders the Room's real components (transcript +
 * composer) against a fully-replayed `FixtureRoomSource` — the same
 * `buildRoomFeed()` script `RoomView` uses, just replayed synchronously via
 * `replayAll()` instead of `RoomView`'s own timer-driven `play()`, so this
 * test is deterministic and doesn't need fake timers.
 *
 * Covers the three assertions called out for lane 2: bubbles align by
 * author, the session card expands its step log, and `/` opens the skills
 * palette.
 */

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

function replayedSnapshot(): RoomSnapshot {
  const source = new FixtureRoomSource(buildRoomFeed());
  source.replayAll();
  return source.getSnapshot();
}

async function setTextareaValue(textarea: HTMLTextAreaElement | null, value: string): Promise<void> {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    valueSetter?.call(textarea, value);
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Room transcript — bubbles align by author', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('renders bob (the viewer) right-aligned and alice/carol left-aligned', async () => {
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="bob" />);
    });

    const bubbles = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="message-bubble"]'));
    expect(bubbles.length).toBeGreaterThan(0);

    const byBob = bubbles.filter((b) => b.dataset.author === 'bob');
    const byOthers = bubbles.filter((b) => b.dataset.author !== 'bob');
    expect(byBob.length).toBeGreaterThan(0);
    expect(byOthers.length).toBeGreaterThan(0);

    for (const bubble of byBob) {
      expect(bubble.dataset.mine).toBe('true');
      expect(bubble.className).toContain('flex-row-reverse');
    }
    for (const bubble of byOthers) {
      expect(bubble.dataset.mine).toBe('false');
      expect(bubble.className).not.toContain('flex-row-reverse');
    }
  });

  it('renders one session card per real fixture run, each reporting a settled status', async () => {
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="bob" />);
    });

    const cards = host.querySelectorAll<HTMLElement>('[data-testid="session-card"]');
    expect(cards.length).toBe(6);
    for (const card of cards) {
      expect(['done', 'stopped']).toContain(card.dataset.status);
    }
  });

  it('expands a session card\'s full step log when its "N steps" footer is clicked', async () => {
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="bob" />);
    });

    const card = host.querySelector<HTMLElement>('[data-testid="session-card"]');
    expect(card).not.toBeNull();
    const toggle = card!.querySelector<HTMLButtonElement>('button');
    expect(toggle?.textContent).toMatch(/steps?$/);
    const expectedStepCount = Number(toggle?.textContent?.match(/^(\d+) steps?$/)?.[1]);
    expect(expectedStepCount).toBeGreaterThan(0);

    expect(card!.querySelector('[data-testid="session-steps-log"]')).toBeNull();
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Expanded, the card shows the run the way the rig chat does.
    expect(card!.querySelector('[data-testid="session-trace"]')).not.toBeNull();
  });

  it('renders the invite row, join row and comment-mirror lines from the scripted story', async () => {
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="bob" />);
    });

    expect(host.textContent).toContain('Joined');
    expect(host.textContent).toContain('joined the space');
    expect(host.querySelectorAll('[data-testid="comment-mirror-line"]').length).toBe(2);
  });
});

describe('Room composer — palette on "/"', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('opens the skills palette when the composer starts with "/", and closes it once the text no longer does', async () => {
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(
        <Composer
          spaceName={snapshot.name}
          members={snapshot.members}
          agents={snapshot.agents}
          skills={snapshot.skills}
          onSend={() => {}}
        />
      );
    });
    expect(snapshot.skills.length).toBeGreaterThan(0);
    expect(host.querySelector('[data-testid="skills-palette"]')).toBeNull();

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
    await setTextareaValue(textarea, '/');

    const palette = host.querySelector('[data-testid="skills-palette"]');
    expect(palette).not.toBeNull();
    expect(palette?.textContent).toContain('Skills in this space');
    expect(palette?.textContent).toContain(snapshot.skills[0].cmd);
    expect(palette?.textContent).toContain('added by');

    await setTextareaValue(textarea, 'hello');
    expect(host.querySelector('[data-testid="skills-palette"]')).toBeNull();
  });

  it('opens the mention completion on "@" with a matching person or agent', async () => {
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(
        <Composer
          spaceName={snapshot.name}
          members={snapshot.members}
          agents={snapshot.agents}
          skills={snapshot.skills}
          onSend={() => {}}
        />
      );
    });

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
    await setTextareaValue(textarea, '@');

    const mentionPalette = host.querySelector('[data-testid="mention-palette"]');
    expect(mentionPalette).not.toBeNull();
    expect(mentionPalette?.textContent).toContain('@');
  });
});

describe('Session card — approvals belong to the owner', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const meta: SessionRunMeta = {
    id: 'run-1',
    agent: 'claude',
    owner: 'alice',
    model: 'sonnet',
    title: '',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  const alice: RoomMember = {
    id: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
    role: 'CTO',
    initial: 'A',
    status: 'here',
  };
  const events: SessionEvent[] = [
    { seq: 1, kind: 'tool_call', payload: { toolCallId: 't1', title: 'npm test', kind: 'execute', status: 'pending' } },
    {
      seq: 2,
      kind: 'permission_requested',
      payload: {
        requestId: 'perm-1',
        toolCall: { toolCallId: 't1', title: 'npm test' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    },
  ];

  it("shows the owner the approval prompt, and answers with the chosen option", async () => {
    const answers: Array<[string, string]> = [];
    await act(async () => {
      root.render(
        <SessionCard
          meta={meta}
          events={events}
          owner={alice}
          onResolvePermission={(requestId, optionId) => answers.push([requestId, optionId])}
        />
      );
    });

    expect(host.querySelector('[data-testid="permission-waiting-line"]')).toBeNull();
    const allow = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow');
    expect(allow).toBeDefined();
    await act(async () => {
      allow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(answers).toEqual([['perm-1', 'allow']]);
  });

  it('shows everyone else one muted waiting line and no buttons, then nothing once decided', async () => {
    await act(async () => {
      root.render(<SessionCard meta={meta} events={events} owner={alice} />);
    });
    expect(host.querySelector('[data-testid="permission-waiting-line"]')?.textContent).toBe(
      "Waiting on Alice's approval"
    );
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Allow')).toBe(false);

    const decided: SessionEvent[] = [
      ...events,
      {
        seq: 3,
        kind: 'permission_decided',
        payload: { requestId: 'perm-1', toolCallId: 't1', optionId: 'allow', outcome: 'allowed' },
      },
    ];
    await act(async () => {
      root.render(<SessionCard meta={meta} events={decided} owner={alice} />);
    });
    expect(host.querySelector('[data-testid="permission-waiting-line"]')).toBeNull();
  });
});

describe('Room transcript — doc comment threads', () => {
  const msg = (id: string, extra: Partial<RoomMessage>): RoomMessage => ({
    id,
    seq: 0,
    authorId: 'dylan',
    createdAt: '',
    time: '11:00',
    body: id,
    meta: { kind: 'text' },
    ...extra,
  });
  const comment = (id: string, isReply: boolean) =>
    msg(id, {
      threadId: 'c1',
      meta: { kind: 'comment_mirror', commentId: 'c1', path: 'signups.md', quote: '| W2 |', ...(isReply ? { isReply: true } : {}) },
    });

  it('groups a thread (comment, replies, its agent run) into one unit placed at its latest activity', () => {
    const units = groupThreads([
      comment('c1', false),
      msg('chat-1', {}),
      comment('r1', true),
      msg('run-msg', { threadId: 'c1', meta: { kind: 'session', runId: 'run-1' } }),
      msg('chat-2', {}),
    ]);
    expect(units.map((u) => (u.kind === 'message' ? u.message.id : `thread:${u.messages.map((m) => m.id).join(',')}`))).toEqual([
      'chat-1',
      'thread:c1,r1,run-msg',
      'chat-2',
    ]);
  });

  it('shows the latest replies and folds older ones behind "Show N earlier replies"', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const snapshot = replayedSnapshot();
    snapshot.messages = [comment('c1', false), comment('r1', true), comment('r2', true), comment('r3', true), comment('r4', true), comment('r5', true)];
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="bob" />);
    });
    expect(host.querySelectorAll('[data-testid="comment-thread"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="comment-thread-reply"]')).toHaveLength(3);
    const more = host.querySelector<HTMLButtonElement>('[data-testid="thread-show-earlier"]');
    expect(more?.textContent).toBe('Show 2 earlier replies');
    await act(async () => {
      more!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.querySelectorAll('[data-testid="comment-thread-reply"]')).toHaveLength(5);
    await act(async () => root.unmount());
    host.remove();
  });
});

