import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '@renderer/features/spaces/components/composer';
import { ConversationMap } from '@renderer/features/spaces/components/conversation-map';
import { AgentSettingsContext, type AgentSettingsApi } from '@renderer/features/spaces/components/agent-settings';
import { groupThreads, RoomTranscript } from '@renderer/features/spaces/components/room-transcript';
import { RoomView } from '@renderer/features/spaces/components/room-view';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import { buildRoomFeed } from '@renderer/features/spaces/fixtures/room-feed';
import { FixtureRoomSource } from '@renderer/features/spaces/room-source';
import type { RoomMember, RoomMessage, RoomSnapshot, SessionEvent, SessionRunMeta } from '@renderer/features/spaces/types';
// Real tokens — the message-row/session-card class assertions below rely
// on the actual `--accent`/`--bg-2` etc. custom properties being present,
// same as artifact-view.test.tsx.
import '@renderer/tokens.css';

// The session card renders answers with SafeMarkdown, which imports the IPC
// bridge (for opening links); nothing here clicks a link.
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    // No live relay here: the Room offers the scripted demo instead.
    rig: { spacesConnection: { getConnectionInfo: async () => ({ success: false, error: { message: 'offline' } }) } },
  },
}));

/**
 * Spaces (lane 2): renders the Room's real components (transcript +
 * composer) against a fully-replayed `FixtureRoomSource` — the same
 * `buildRoomFeed()` script `RoomView` uses, just replayed synchronously via
 * `replayAll()` instead of `RoomView`'s own timer-driven `play()`, so this
 * test is deterministic and doesn't need fake timers.
 *
 * Covers the three assertions called out for lane 2: messages render as
 * flat rows, the session card expands its step log, and `/` opens the skills
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

describe('Room transcript — flat rows', () => {
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

  it('puts your messages on the right and names everyone else on the left', async () => {
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="bob" />);
    });

    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="message-row"]'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.dataset.author === 'bob')).toBe(true);
    expect(rows.some((r) => r.dataset.author !== 'bob')).toBe(true);

    for (const row of rows) {
      // Yours on the right without a name; everyone else's on the left, named.
      expect(row.dataset.mine).toBe(String(row.dataset.author === 'bob'));
      if (row.dataset.mine === 'true') {
        expect(row.className).toContain('justify-end');
      } else if (row.dataset.continued === 'false') {
        const author = snapshot.members.find((m) => m.id === row.dataset.author);
        expect(row.textContent).toContain(author?.name ?? row.dataset.author);
      }
    }
    // Day breaks come from the messages' own timestamps.
    expect(host.querySelectorAll('[data-testid="day-divider"]').length).toBeGreaterThan(0);
  });

  it('shows a reply with the message it quotes, and offers Reply on hover', async () => {
    const snapshot = replayedSnapshot();
    const replies: unknown[] = [];
    const quoted = snapshot.messages.find((m) => m.meta.kind === 'text' && m.authorId !== 'bob')!;
    const reply: RoomMessage = {
      ...quoted,
      id: 'reply-1',
      authorId: 'bob',
      body: 'on it',
      meta: { kind: 'text', replyTo: { id: quoted.id, authorId: quoted.authorId, label: 'Alice', excerpt: 'the quoted bit' } },
    };
    await act(async () => {
      root.render(
        <RoomTranscript
          snapshot={{ ...snapshot, messages: [...snapshot.messages, reply] }}
          ownId="bob"
          onReply={(ref) => replies.push(ref)}
        />
      );
    });
    const row = host.querySelector<HTMLElement>('[data-testid="message-row"][data-author="bob"]:last-of-type');
    expect(host.textContent).toContain('the quoted bit');
    const replyButtons = host.querySelectorAll<HTMLButtonElement>('[aria-label="Reply"]');
    expect(replyButtons.length).toBeGreaterThan(0);
    await act(async () => {
      replyButtons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(replies).toHaveLength(1);
    expect(row).not.toBeNull();
  });

  it('marks where you left off with a "New" line', async () => {
    const snapshot = replayedSnapshot();
    const others = snapshot.messages.filter((m) => m.authorId !== 'bob');
    const lastRead = others[Math.floor(others.length / 2)]!.seq;
    localStorage.setItem('rig-room-last-seen:space-1', String(lastRead));
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="bob" readKey="space-1" />);
    });
    const divider = host.querySelector('[data-testid="new-divider"]');
    expect(divider).not.toBeNull();
    const firstNew = snapshot.messages.find((m) => m.seq > lastRead && m.authorId !== 'bob')!;
    // The line sits right above the unit holding the first unread message.
    const next = divider!.nextElementSibling as HTMLElement | null;
    expect(next?.dataset.messageId === firstNew.id || next?.dataset.messageId === firstNew.threadId || !!next?.querySelector(`[data-message-id]`)).toBe(true);
    localStorage.removeItem('rig-room-last-seen:space-1');
  });

  it('shows the outline rail once the conversation is taller than its window, and jumps on click', async () => {
    const jumps: string[] = [];
    const entries = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      tone: (i % 3 === 0 ? 'agent' : 'person') as 'agent' | 'person',
      label: `Row ${i}`,
      preview: () => `preview ${i}`,
    }));
    function Harness() {
      const scrollRef = React.useRef<HTMLDivElement>(null);
      const contentRef = React.useRef<HTMLDivElement>(null);
      return (
        <div style={{ position: 'relative', width: 600 }}>
          <div ref={scrollRef} style={{ height: 200, overflowY: 'auto' }}>
            <div ref={contentRef} style={{ position: 'relative' }}>
              {entries.map((e) => (
                <div key={e.id} data-message-id={e.id} style={{ height: 100 }} />
              ))}
            </div>
          </div>
          <ConversationMap scrollRef={scrollRef} contentRef={contentRef} entries={entries} onJump={(id) => jumps.push(id)} />
        </div>
      );
    }
    await act(async () => {
      root.render(<Harness />);
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="conversation-map"]')).not.toBeNull());
    // At rest: a small minimap. Focusing it opens the readable outline.
    const minimap = host.querySelector<HTMLButtonElement>('[aria-label="Outline"]')!;
    await act(async () => {
      minimap.focus();
    });
    const rows = host.querySelectorAll<HTMLButtonElement>('[data-testid="conversation-map"] [role="listitem"]');
    expect(rows).toHaveLength(10);
    expect(rows[4]!.textContent).toContain('preview 4');
    await act(async () => {
      rows[4]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(jumps).toEqual(['m4']);
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

  it('opens a finished turn\'s steps from its summary line, and the full trace from there', async () => {
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="bob" />);
    });

    const card = [...host.querySelectorAll<HTMLElement>('[data-testid="session-card"]')].find((c) =>
      c.querySelector('[data-testid="session-summary"]')
    );
    expect(card).toBeDefined();
    const summary = card!.querySelector<HTMLButtonElement>('[data-testid="session-summary"]')!;
    expect(summary.textContent).toMatch(/^Worked .* · \d+ steps?/);

    expect(card!.querySelector('[data-testid="session-steps"]')).toBeNull();
    await act(async () => {
      summary.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const steps = card!.querySelectorAll('[data-testid="session-step"]');
    expect(steps.length).toBe(Number(summary.textContent?.match(/(\d+) steps?/)?.[1]));

    // The full trace opens beside the Room, rendered the way the rig chat does.
    await act(async () => {
      card!
        .querySelector<HTMLButtonElement>('[data-testid="session-open-trace"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="session-trace"]')).not.toBeNull();
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

describe('Room view — renders through loading into content', () => {
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

  // Regression: a hook placed after RoomView's early returns crashed the
  // Room the moment it went from "no snapshot yet" to showing messages.
  it('goes from the connect error to the scripted demo without breaking the rules of hooks', async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener('error', onError);
    await act(async () => {
      root.render(<RoomView bindingId="b1" spaceName="Room" />);
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Could not connect'));
    const demo = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('scripted demo'))!;
    await act(async () => {
      demo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="room-view"]')).not.toBeNull());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="room-transcript"]')).not.toBeNull());
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
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

  it('moves through the menu with the arrow keys and picks with Enter, agents first', async () => {
    const snapshot = replayedSnapshot();
    const own = snapshot.agents.filter((a) => a.owner === 'bob');
    await act(async () => {
      root.render(
        <Composer spaceName={snapshot.name} members={snapshot.members} agents={own} skills={snapshot.skills} onSend={() => {}} />
      );
    });
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await setTextareaValue(textarea, 'hey @');
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options[0]?.textContent).toContain(`@${own[0]!.agent}`);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const second = [...host.querySelectorAll<HTMLElement>('[role="option"]')][1]!;
    expect(second.getAttribute('aria-selected')).toBe('true');
    const label = second.querySelector('span:nth-child(2)')!.textContent!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(textarea.value).toBe(`hey ${label} `);
    expect(host.querySelector('[data-testid="mention-palette"]')).toBeNull();
  });

  it('sends a quote-reply with its reference, and says when the mentioned agent is busy', async () => {
    const snapshot = replayedSnapshot();
    const sent: Array<[string, unknown]> = [];
    const replyTo = { id: 'm1', authorId: 'alice', label: 'Alice', excerpt: 'Why did organic drop?' };
    await act(async () => {
      root.render(
        <Composer
          spaceName={snapshot.name}
          members={snapshot.members}
          agents={snapshot.agents}
          skills={snapshot.skills}
          onSend={(text, ref) => sent.push([text, ref])}
          replyTo={replyTo}
          busyAgents={['claude']}
        />
      );
    });
    expect(host.querySelector('[data-testid="composer-reply"]')?.textContent).toContain('Alice');
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await setTextareaValue(textarea, '@claude look again');
    expect(host.querySelector('[data-testid="composer-queue-note"]')).not.toBeNull();
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(sent).toEqual([['@claude look again', { replyTo, agent: 'claude', attach: null }]]);
  });

  it('shows pills for your tagged agent and the open doc, and dropping the agent pill sends plain chat', async () => {
    const snapshot = replayedSnapshot();
    const own = snapshot.agents.filter((a) => a.owner === 'bob');
    const sent: Array<[string, unknown]> = [];
    await act(async () => {
      root.render(
        <Composer
          spaceName={snapshot.name}
          members={snapshot.members}
          agents={own}
          skills={snapshot.skills}
          onSend={(text, context) => sent.push([text, context])}
          openDoc="docs/metrics.md"
        />
      );
    });
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await setTextareaValue(textarea, 'hello there');
    expect(host.querySelector('[data-testid="composer-pills"]')).toBeNull();

    await setTextareaValue(textarea, '@claude add a churn row');
    expect(host.querySelector('[data-testid="composer-agent-pill"]')?.textContent).toContain('Claude');
    expect(host.querySelector('[data-testid="composer-doc-pill"]')?.textContent).toContain('metrics.md');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Ask Claude'))).toBe(true);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(sent.at(-1)).toEqual(['@claude add a churn row', { replyTo: undefined, agent: 'claude', attach: 'docs/metrics.md' }]);

    await setTextareaValue(textarea, '@claude this is just chat');
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="composer-agent-pill"] [data-testid="context-pill-dismiss"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="composer-agent-pill"]')).toBeNull();
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(sent.at(-1)).toEqual(['@claude this is just chat', { replyTo: undefined, agent: null, attach: null }]);
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

    expect(host.querySelector('[data-testid="session-live-line"]')?.textContent).toContain(
      'Waiting for your approval'
    );
    const allow = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow once');
    expect(allow).toBeDefined();
    await act(async () => {
      allow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(answers).toEqual([['perm-1', 'allow']]);
  });

  it("shows everyone else who it's waiting on and no buttons, then moves on once decided", async () => {
    await act(async () => {
      root.render(<SessionCard meta={meta} events={events} owner={alice} />);
    });
    expect(host.querySelector('[data-testid="session-live-line"]')?.textContent).toContain(
      "Waiting on Alice's approval"
    );
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Allow once')).toBe(false);
    // Nothing to offer on someone else's running turn: no empty action bar either.
    expect(host.querySelector('[data-testid="row-actions"]')).toBeNull();

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
    expect(host.querySelector('[data-testid="session-live-line"]')?.textContent).not.toContain('approval');
    // The decision stays on the step as a record everyone can read.
    expect(host.querySelector('[data-testid="session-decision"]')?.textContent).toBe('Allowed once by Alice');
  });
});

describe('Session card — plan and thinking', () => {
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
    id: 'run-plan',
    agent: 'claude',
    owner: 'alice',
    model: 'sonnet',
    title: '',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  const events: SessionEvent[] = [
    { seq: 1, kind: 'agent_thought_chunk', payload: { content: { type: 'text', text: 'First the doc. Then the history' } } },
    {
      seq: 2,
      kind: 'plan',
      payload: { entries: [{ content: 'Read the doc', status: 'completed' }, { content: 'Check history', status: 'in_progress' }] },
    },
  ];

  it('shows the plan while running, and a glimpse of the thinking in the live line', async () => {
    await act(async () => {
      root.render(<SessionCard meta={meta} events={events} owner={undefined} />);
    });
    expect(host.querySelector('[data-testid="session-plan"]')?.textContent).toContain('1 of 2');
    expect(host.querySelector('[data-testid="session-live-line"]')?.textContent).toContain('Then the history');
  });

  it('folds thinking and plan into the summary once done', async () => {
    const done: SessionEvent[] = [...events, { seq: 3, kind: 'turn_ended', payload: { status: 'done' } }];
    await act(async () => {
      root.render(<SessionCard meta={{ ...meta, status: 'done' }} events={done} owner={undefined} />);
    });
    expect(host.querySelector('[data-testid="session-plan"]')).toBeNull();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-summary"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="session-plan"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-thinking"]')?.textContent).toContain('6 words');
  });

  it('lists what the answer rests on as Sources, leaving out files it changed', async () => {
    const opened: string[] = [];
    const run: SessionEvent[] = [
      { seq: 1, kind: 'tool_call', payload: { toolCallId: 'a', kind: 'read', title: 'Read signups.md', status: 'completed', locations: [{ path: '/w/signups.md' }] } },
      { seq: 2, kind: 'tool_call', payload: { toolCallId: 'b', kind: 'read', title: 'Read AGENTS.md', status: 'completed' } },
      {
        seq: 3,
        kind: 'tool_call',
        payload: { toolCallId: 'c', kind: 'edit', title: 'Edit notes.md', status: 'completed', content: [{ type: 'diff', path: '/w/notes.md', oldText: 'a', newText: 'b' }] },
      },
      { seq: 4, kind: 'tool_call', payload: { toolCallId: 'd', kind: 'read', title: 'Read notes.md', status: 'completed', locations: [{ path: '/w/notes.md' }] } },
      { seq: 5, kind: 'agent_message_chunk', payload: { messageId: 'x', content: { type: 'text', text: 'Here you go.' } } },
      { seq: 6, kind: 'turn_ended', payload: { status: 'done' } },
    ];
    await act(async () => {
      root.render(
        <SessionCard meta={{ ...meta, status: 'done' }} events={run} owner={undefined} onOpenFile={(p) => opened.push(p)} />
      );
    });
    const chips = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="session-sources"] button')];
    expect(chips.map((c) => c.textContent)).toEqual(['signups.md', 'AGENTS.md']);
    await act(async () => {
      chips[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toEqual(['/w/signups.md']);
  });

  it("shows your agent's settings on its latest turn and changes them from the menu", async () => {
    const changes: unknown[] = [];
    let mode = 'default';
    const config = () => ({
      model: { selected: 'opus', options: [{ id: 'opus', name: 'Opus 5.5' }, { id: 'sonnet', name: 'Sonnet 5' }] },
      effort: null,
      mode: {
        selected: mode,
        options: [
          { id: 'default', name: 'Ask first', description: 'Asks before edits and commands' },
          { id: 'acceptEdits', name: 'Auto-edit' },
        ],
      },
    });
    const api: AgentSettingsApi = {
      load: async () => config(),
      change: async (_agent, change) => {
        changes.push(change);
        if (change.mode) mode = change.mode;
        return config();
      },
    };
    const done: SessionEvent[] = [
      { seq: 1, kind: 'usage_update', payload: { size: 1000000, used: 46000 } },
      { seq: 2, kind: 'turn_ended', payload: { status: 'done' } },
    ];
    await act(async () => {
      root.render(
        <AgentSettingsContext.Provider value={api}>
          <SessionCard meta={{ ...meta, status: 'done' }} events={done} owner={undefined} viewerIsOwner showSettings />
        </AgentSettingsContext.Provider>
      );
    });
    expect(host.querySelector('[data-testid="agent-settings"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Context 5% used"]')).not.toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="agent-setting-mode"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="agent-setting-menu-mode"]')?.textContent).toContain('Auto-edit'));
    const autoEdit = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="agent-setting-menu-mode"] button')].find((b) =>
      b.textContent?.includes('Auto-edit')
    )!;
    await act(async () => {
      autoEdit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes).toEqual([{ mode: 'acceptEdits' }]);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="agent-setting-mode"]')?.textContent).toContain('Auto-edit'));
  });

  it('offers Retry on a failed run and Continue on a stopped one, as new turns for your agent', async () => {
    const reruns: Array<[string, string]> = [];
    const failed: SessionEvent[] = [{ seq: 1, kind: 'turn_ended', payload: { status: 'failed', reason: 'timed out' } }];
    await act(async () => {
      root.render(
        <SessionCard
          meta={{ ...meta, status: 'failed' }}
          events={failed}
          owner={undefined}
          prompt="why did organic drop?"
          onRerun={(agent, prompt) => reruns.push([agent, prompt])}
        />
      );
    });
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const stopped: SessionEvent[] = [{ seq: 1, kind: 'turn_ended', payload: { status: 'stopped' } }];
    await act(async () => {
      root.render(
        <SessionCard
          meta={{ ...meta, status: 'stopped' }}
          events={stopped}
          owner={undefined}
          prompt="why did organic drop?"
          onRerun={(agent, prompt) => reruns.push([agent, prompt])}
        />
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="session-continue"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(reruns).toEqual([
      ['claude', 'why did organic drop?'],
      ['claude', 'Continue where you left off.'],
    ]);
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

