import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectResult } from '@shared/spaces/connectors';
import { Composer } from '@renderer/features/spaces/components/composer';
import { ConversationMap } from '@renderer/features/spaces/components/conversation-map';
import {
  AgentConfigRow,
  AgentSettingsContext,
  prettyModelId,
  type AgentSettingsApi,
} from '@renderer/features/spaces/components/agent-settings';
import { AgentRows } from '@renderer/features/spaces/components/agent-rows';
import { ConnectorsSection } from '@renderer/features/spaces/components/connectors-panel';
import { groupThreads, RoomTranscript } from '@renderer/features/spaces/components/room-transcript';
import { RoomView } from '@renderer/features/spaces/components/room-view';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import { ConnectorCard } from '@renderer/features/spaces/components/transcript-items';
import { connectorsApi } from '@renderer/features/spaces/connectors-api';
import { buildRoomFeed } from '@renderer/features/spaces/fixtures/room-feed';
import type { RelayRoomSource } from '@renderer/features/spaces/relay-room-source';
import { FixtureRoomSource } from '@renderer/features/spaces/room-source';
import type { RoomConnector, RoomMember, RoomMessage, RoomSnapshot, SessionEvent, SessionRunMeta } from '@renderer/features/spaces/types';
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

// The connectors panel/pills go through this one wrapper (connectors-api.ts)
// rather than the IPC bridge directly — mocked here so each test controls
// what "your own connection" looks like without any RPC plumbing.
vi.mock('@renderer/features/spaces/connectors-api', () => ({
  connectorsApi: {
    list: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue({ ok: true }),
    cancel: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** A fake `RelayRoomSource` exposing only what `ConnectorsSection` calls on it. */
function fakeConnectorsSource(overrides: Partial<Pick<RelayRoomSource, 'addConnector' | 'removeConnector' | 'refreshConnections'>> = {}): RelayRoomSource {
  return {
    addConnector: vi.fn().mockResolvedValue({ ok: true }),
    removeConnector: vi.fn().mockResolvedValue({ ok: true }),
    refreshConnections: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RelayRoomSource;
}

function connectorsSnapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    name: 'growth',
    ready: true,
    members: [
      { id: 'dylan', name: 'Dylan', email: 'dylan@acme.com', role: 'owner', initial: 'D', status: 'here' },
      { id: 'sam', name: 'Sam', email: 'sam@acme.com', role: 'viewer', initial: 'S', status: 'here' },
    ],
    agents: [],
    connectors: [],
    skills: [],
    messages: [],
    invitesById: {},
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    typingUserIds: [],
    ...overrides,
  };
}

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

  it("opens a setting in the agent pill as inline choices, and folds back after a pick", async () => {
    const snapshot = replayedSnapshot();
    const own = snapshot.agents.filter((a) => a.owner === 'bob');
    const changes: unknown[] = [];
    let model = 'default';
    const config = () => ({
      model: {
        selected: model,
        options: [
          { id: 'default', name: 'Default (recommended)', description: 'Opus 4.7 · Most capable' },
          { id: 'sonnet', name: 'Sonnet' },
        ],
      },
      effort: null,
      mode: { selected: 'default', options: [{ id: 'default', name: 'Manual' }] },
    });
    const api: AgentSettingsApi = {
      load: async () => config(),
      change: async (_agent, change) => {
        changes.push(change);
        if (change.model) model = change.model;
        return config();
      },
    };
    await act(async () => {
      root.render(
        <AgentSettingsContext.Provider value={api}>
          <Composer spaceName={snapshot.name} members={snapshot.members} agents={own} skills={snapshot.skills} onSend={() => {}} />
        </AgentSettingsContext.Provider>
      );
    });
    await setTextareaValue(host.querySelector<HTMLTextAreaElement>('textarea'), '@claude hi');
    await vi.waitFor(() => expect(host.querySelector('[data-testid="agent-setting-model"]')?.textContent).toContain('Opus 4.7'));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="agent-setting-model"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const sonnet = [...host.querySelectorAll('[data-testid="agent-choices-model"] button')].find((b) => b.textContent === 'Sonnet')!;
    await act(async () => {
      sonnet.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes).toEqual([{ model: 'sonnet' }]);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="agent-choices-model"]')).toBeNull());
    expect(host.querySelector('[data-testid="agent-setting-model"]')?.textContent).toContain('Sonnet');
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

  it("expands your agent's settings in place from the space panel row and changes them there", async () => {
    const changes: unknown[] = [];
    let mode = 'default';
    const config = () => ({
      model: {
        selected: 'default',
        options: [
          { id: 'default', name: 'Default (recommended)', description: 'Opus 4.7 with 1M context · Most capable for complex work' },
          { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 4.6 · Best for everyday tasks' },
        ],
      },
      effort: { selected: 'high', options: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
      mode: {
        selected: mode,
        options: [
          { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
          { id: 'acceptEdits', name: 'Accept edits' },
          { id: 'bypassPermissions', name: 'Bypass permissions' },
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
    await act(async () => {
      root.render(
        <AgentSettingsContext.Provider value={api}>
          <AgentConfigRow
            agent="claude"
            avatar={null}
            busy={null}
            lastModel={null}
            usage={{ used: 46000, size: 1000000, costUsd: null }}
          />
        </AgentSettingsContext.Provider>
      );
    });
    // The row names the model the default resolves to, and expands in place (no menu).
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="space-agent-row"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="agent-choices-mode"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="agent-choices-model"]')?.textContent).toContain('Opus 4.7 (1M)');
    expect(host.textContent).not.toContain('Default (recommended)');
    expect(host.querySelector('[data-testid="space-agent-row"]')?.textContent).toContain('Opus 4.7 (1M) · Manual');

    const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const chip = (dimension: string, text: string) =>
      [...host.querySelectorAll(`[data-testid="agent-choices-${dimension}"] button`)].find((b) => b.textContent === text)!;
    await act(async () => click(chip('mode', 'Accept edits')));
    // A mode that acts without asking needs a second click: the first asks to confirm.
    await act(async () => click(chip('mode', 'Bypass permissions')));
    expect(changes).toEqual([{ mode: 'acceptEdits' }]);
    await act(async () => click(chip('mode', 'Confirm?')));
    await act(async () => click(chip('effort', 'Low')));
    expect(changes).toEqual([{ mode: 'acceptEdits' }, { mode: 'bypassPermissions' }, { effort: 'low' }]);
  });

  it('names a model the agent no longer lists instead of showing nothing, and lists others\' agents read-only', async () => {
    expect(prettyModelId('claude-opus-4-7')).toBe('Opus 4.7');
    expect(prettyModelId('claude-fable-5-1[1m]')).toBe('Fable 5.1 (1M)');
    expect(prettyModelId('gpt-6-sol')).toBe('gpt-6-sol');

    const api: AgentSettingsApi = {
      load: async () => ({
        model: { selected: 'claude-opus-4-7', options: [{ id: 'sonnet', name: 'Sonnet' }] },
        effort: null,
        mode: { selected: 'default', options: [{ id: 'default', name: 'Manual' }] },
      }),
      change: async () => ({ error: 'unused' }),
    };
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(
        <AgentSettingsContext.Provider value={api}>
          <AgentRows snapshot={snapshot} selfUserId="bob" />
        </AgentSettingsContext.Provider>
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="space-agent-row"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="agent-choices-model"]')?.textContent).toContain('Opus 4.7'));
    // Other people's agents that worked here: shown, not changeable.
    const theirs = host.querySelectorAll<HTMLElement>('[data-testid="space-agent-row-theirs"]');
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs[0]!.querySelector('button')).toBeNull();
    expect(theirs[0]!.title).toMatch(/^Only .+ can change/);
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

describe('Connectors — space panel', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(connectorsApi.list).mockReset().mockResolvedValue([]);
    vi.mocked(connectorsApi.connect).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(connectorsApi.cancel).mockReset().mockResolvedValue(undefined);
    vi.mocked(connectorsApi.disconnect).mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('shows the empty state, and the Add pill only for a member who can write', async () => {
    const snapshot = connectorsSnapshot();
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" source={fakeConnectorsSource()} />);
    });
    expect(host.querySelector('[data-testid="connectors-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="connectors-add-toggle"]')).not.toBeNull();

    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="sam" source={fakeConnectorsSource()} />);
    });
    expect(host.querySelector('[data-testid="connectors-add-toggle"]')).toBeNull();
  });

  it('picking a catalog tool opens its consent line, and "Continue in browser" connects then adds it to the space', async () => {
    const source = fakeConnectorsSource();
    const snapshot = connectorsSnapshot();
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" source={source} />);
    });
    await act(async () => click(host.querySelector('[data-testid="connectors-add-toggle"]')!));
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="connector-catalog-row"]')];
    expect(rows.length).toBeGreaterThan(0);
    const linearRow = rows.find((r) => r.textContent?.includes('Linear'))!;
    await act(async () => click(linearRow));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="connector-consent"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="connector-consent"]')?.textContent).toContain('sign in to Linear in your browser');

    const go = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Continue in browser')!;
    await act(async () => click(go));
    await vi.waitFor(() => expect(connectorsApi.connect).toHaveBeenCalledWith('linear'));
    await vi.waitFor(() => expect(source.addConnector).toHaveBeenCalledWith('linear'));
  });

  it('shows the waiting state while connecting, and Cancel aborts it', async () => {
    const inFlight: { settle: ((r: ConnectResult) => void) | null } = { settle: null };
    vi.mocked(connectorsApi.connect).mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight.settle = resolve;
        })
    );
    const snapshot = connectorsSnapshot({
      connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'not_connected' }],
    });
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" source={fakeConnectorsSource()} />);
    });
    await act(async () => click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Connect')!));
    await act(async () => click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Continue in browser')!));
    expect(host.textContent).toContain('Waiting for your browser');

    await act(async () => click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!));
    expect(connectorsApi.cancel).toHaveBeenCalledWith('linear');
    expect(host.textContent).not.toContain('Waiting for your browser');
    inFlight.settle?.({ ok: true }); // let the abandoned promise settle so it doesn't dangle
  });

  it('renders connected, not-connected and expired rows with their sub-line, dot and pill', async () => {
    const snapshot = connectorsSnapshot({
      connectors: [
        { id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' },
        { id: 'notion', name: 'Notion', addedBy: 'sam', mine: 'not_connected' },
        { id: 'sentry', name: 'Sentry', addedBy: 'dylan', mine: 'expired' },
      ],
    });
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" source={fakeConnectorsSource()} />);
    });
    const rowFor = (id: string) => host.querySelector<HTMLElement>(`[data-testid="connector-row"][data-connector="${id}"]`)!;
    expect(rowFor('linear').textContent).toContain('Connected as you');
    expect(rowFor('notion').textContent).toContain('Added by Sam');
    expect([...rowFor('notion').querySelectorAll('button')].some((b) => b.textContent === 'Connect')).toBe(true);
    expect(rowFor('sentry').textContent).toContain('Login expired');
    expect([...rowFor('sentry').querySelectorAll('button')].some((b) => b.textContent === 'Reconnect')).toBe(true);
  });

  it('disconnects your own login with one click, no confirm needed', async () => {
    const source = fakeConnectorsSource();
    const snapshot = connectorsSnapshot({
      connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }],
    });
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" source={source} />);
    });
    const row = host.querySelector<HTMLElement>('[data-testid="connector-row"]')!;
    await act(async () => click([...row.querySelectorAll('button')].find((b) => b.textContent === 'Disconnect mine')!));
    expect(connectorsApi.disconnect).toHaveBeenCalledWith('linear');
    await vi.waitFor(() => expect(source.refreshConnections).toHaveBeenCalled());
  });

  it('removing from the space takes a second click to confirm', async () => {
    const source = fakeConnectorsSource();
    const snapshot = connectorsSnapshot({
      connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }],
    });
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" source={source} />);
    });
    const row = host.querySelector<HTMLElement>('[data-testid="connector-row"]')!;
    const removeButton = () => [...row.querySelectorAll('button')].find((b) => b.textContent?.includes('Remove') || b.textContent === 'Confirm remove?')!;
    await act(async () => click(removeButton()));
    expect(removeButton().textContent).toBe('Confirm remove?');
    expect(source.removeConnector).not.toHaveBeenCalled();
    await act(async () => click(removeButton()));
    expect(source.removeConnector).toHaveBeenCalledWith('linear');
  });
});

describe('Connectors — Room copy and turn footer', () => {
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

  const connectorMessage: RoomMessage = {
    id: 'm-connectors',
    seq: 1,
    authorId: 'dylan',
    createdAt: new Date().toISOString(),
    time: '10:00',
    meta: { kind: 'system', event: 'connectors_added', connectorIds: ['linear'] },
  };

  it("ConnectorCard uses the updated note and offers Connect for a connector you haven't connected", async () => {
    const connectors: RoomConnector[] = [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'not_connected' }];
    const onConnect = vi.fn().mockResolvedValue({ ok: true });
    await act(async () => {
      root.render(<ConnectorCard message={connectorMessage} addedBy={undefined} connectors={connectors} onConnect={onConnect} />);
    });
    expect(host.textContent).toContain("Each person's agent uses their own login");
    expect(host.textContent).not.toContain('read-only');
    await act(async () => click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Connect')!));
    expect(onConnect).toHaveBeenCalledWith('linear');
  });

  it('ConnectorCard shows "Connected as you" once your own login is in place', async () => {
    const connectors: RoomConnector[] = [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }];
    await act(async () => {
      root.render(<ConnectorCard message={connectorMessage} addedBy={undefined} connectors={connectors} />);
    });
    expect(host.textContent).toContain('Connected as you');
  });

  const runMeta: SessionRunMeta = {
    id: 'run-connectors',
    agent: 'claude',
    owner: 'alice',
    model: 'sonnet',
    title: '',
    status: 'done',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
  const gapEvents: SessionEvent[] = [
    { seq: 1, kind: 'agent_message_chunk', payload: { messageId: 'x', content: { type: 'text', text: 'Done.' } } },
    { seq: 2, kind: 'run_connectors', payload: { gaps: [{ id: 'linear', state: 'not_connected' }] } },
    { seq: 3, kind: 'turn_ended', payload: { status: 'done' } },
  ];

  it("shows the connector-gap footer only to the run's own owner, and runs the connect flow from it", async () => {
    const onConnectorConnect = vi.fn().mockResolvedValue({ ok: true });
    await act(async () => {
      root.render(
        <SessionCard meta={runMeta} events={gapEvents} owner={undefined} viewerIsOwner onConnectorConnect={onConnectorConnect} />
      );
    });
    const gaps = host.querySelector('[data-testid="session-connector-gaps"]');
    expect(gaps).not.toBeNull();
    expect(gaps?.textContent).toContain("Linear isn't connected for you");
    await act(async () => click([...gaps!.querySelectorAll('button')].find((b) => b.textContent === 'Connect')!));
    expect(onConnectorConnect).toHaveBeenCalledWith('linear');

    await act(async () => {
      root.render(
        <SessionCard
          meta={runMeta}
          events={gapEvents}
          owner={undefined}
          viewerIsOwner={false}
          onConnectorConnect={onConnectorConnect}
        />
      );
    });
    expect(host.querySelector('[data-testid="session-connector-gaps"]')).toBeNull();
  });

  it('prettifies a connector\'s raw MCP tool name in the step list, with its brand tile', async () => {
    const events: SessionEvent[] = [
      { seq: 1, kind: 'tool_call', payload: { toolCallId: 't1', title: 'mcp__linear__list_issues', kind: 'fetch', status: 'completed' } },
      { seq: 2, kind: 'turn_ended', payload: { status: 'done' } },
    ];
    await act(async () => {
      root.render(<SessionCard meta={{ ...runMeta, status: 'done' }} events={events} owner={undefined} />);
    });
    await act(async () => click(host.querySelector('[data-testid="session-summary"]')!));
    expect(host.querySelector('[data-testid="session-step"]')?.textContent).toContain('Linear · list issues');
  });
});

