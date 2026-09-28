import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorId, ConnectResult, GlobalServer } from '@shared/spaces/connectors';
import { Composer, type ComposerSuggestion } from '@renderer/features/spaces/components/composer';
import { ConversationMap } from '@renderer/features/spaces/components/conversation-map';
import {
  AgentConfigRow,
  AgentSettingsContext,
  prettyModelId,
  type AgentSettingsApi,
} from '@renderer/features/spaces/components/agent-settings';
import { AgentRows } from '@renderer/features/spaces/components/agent-rows';
import { ConnectorGallery } from '@renderer/features/spaces/components/connector-gallery';
import { ConnectorsSection } from '@renderer/features/spaces/components/connectors-panel';
import { groupThreads, RoomTranscript } from '@renderer/features/spaces/components/room-transcript';
import { RoomLoadingSkeleton, RoomView, sendFromComposer, withPendingSends } from '@renderer/features/spaces/components/room-view';
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
  // The Room listens for its owner overlay's pushes (never, with no relay).
  events: { on: () => () => {} },
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
    globalSetup: vi.fn().mockResolvedValue([]),
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

  it('shows a message you just sent right away, as sending, until the relay hands it back', async () => {
    const snapshot = replayedSnapshot();
    const lastSeq = Math.max(...snapshot.messages.map((m) => m.seq));
    const pending = { localId: 'sending-1', text: 'on my way', createdAt: '2026-09-27T20:00:00.000Z', id: null };
    const shown = withPendingSends(snapshot, [pending], 'bob');
    // At the end, yours, and never ahead of the relay's own numbering (the read marker uses it).
    expect(shown.messages.at(-1)).toMatchObject({ id: 'sending-1', authorId: 'bob', body: 'on my way', sending: true, seq: lastSeq });

    await act(async () => {
      root.render(<RoomTranscript snapshot={shown} ownId="bob" />);
    });
    const row = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="message-row"]')).at(-1)!;
    expect(row.dataset.sending).toBe('true');
    expect(row.textContent).toContain('Sending…');
    expect(row.textContent).toContain('on my way');

    // Once the real message (same id) is in the snapshot, the pending one is gone.
    const real: RoomMessage = { ...shown.messages.at(-1)!, id: 'msg-9', seq: lastSeq + 1, sending: undefined };
    const arrived = { ...snapshot, messages: [...snapshot.messages, real] };
    const after = withPendingSends(arrived, [{ ...pending, id: 'msg-9' }], 'bob');
    expect(after).toBe(arrived);
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

  it("renders the relay's member_joined system message as a quiet join row with the member's avatar", async () => {
    const snapshot = replayedSnapshot();
    const joiner = snapshot.members.find((m) => m.id !== 'bob')!;
    const last = snapshot.messages[snapshot.messages.length - 1]!;
    const joined: RoomMessage = {
      id: 'm-joined',
      seq: last.seq + 1,
      authorId: joiner.id,
      createdAt: last.createdAt,
      time: last.time,
      body: 'joined the space',
      meta: { kind: 'system', event: 'member_joined' },
    };
    await act(async () => {
      root.render(<RoomTranscript snapshot={{ ...snapshot, messages: [...snapshot.messages, joined] }} ownId="bob" />);
    });

    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="join-row"]')];
    const row = rows.find((r) => r.textContent?.includes(`${joiner.name} joined the space`));
    expect(row).toBeTruthy();
    // Pictured as the member, not as a generic system line.
    expect(row!.firstElementChild?.textContent || row!.querySelector('img, svg')).toBeTruthy();
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

  // Calm Room open: rows already in the snapshot when the transcript first
  // mounts (a whole, already-loaded batch — see `RelayRoomSource`'s own
  // header) never get the enter animation; only a message added afterward
  // does. Same `root`/component instance across both renders, so this is a
  // re-render of the mounted transcript, not a fresh mount.
  it('marks only a newly-added message for the enter animation — initial rows never re-animate', async () => {
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(<RoomTranscript snapshot={snapshot} ownId="bob" />);
    });
    const initialRows = [...host.querySelectorAll<HTMLElement>('[data-message-id]')];
    expect(initialRows.length).toBeGreaterThan(0);
    expect(initialRows.every((r) => r.dataset.rowEntered === undefined)).toBe(true);

    const last = snapshot.messages.at(-1)!;
    const added: RoomMessage = {
      ...last,
      id: 'brand-new-message',
      seq: last.seq + 1,
      authorId: last.authorId === 'bob' ? 'alice' : 'bob',
      body: 'a brand new message',
      meta: { kind: 'text' },
      threadId: undefined,
    };
    await act(async () => {
      root.render(<RoomTranscript snapshot={{ ...snapshot, messages: [...snapshot.messages, added] }} ownId="bob" />);
    });

    const newRow = host.querySelector<HTMLElement>(`[data-message-id="${added.id}"]`);
    expect(newRow?.dataset.rowEntered).toBe('true');
    // Every row that was already there stays unmarked.
    for (const row of initialRows) {
      const stillThere = host.querySelector<HTMLElement>(`[data-message-id="${row.dataset.messageId}"]`);
      expect(stillThere?.dataset.rowEntered).toBeUndefined();
    }
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

  // Regression (d6a027f98): the body's ResizeObserver used to attach in a
  // mount-time `[]` effect, but the body only renders once a snapshot has
  // loaded — so it never attached, `bodyWidth` stayed 0, and the panel
  // clearance (`TRANSCRIPT_COLUMN_PX + 2 * PANEL_LANE_PX - bodyWidth`)
  // shoved the transcript ~1368px left even in a wide window.
  it('measures the body once the snapshot arrives after mount — no panel clearance in a wide window', async () => {
    host.style.width = '1600px';
    host.style.height = '800px';
    await act(async () => {
      root.render(<RoomView bindingId="b1" spaceName="Room" renderPanel={() => null} />);
    });
    // No snapshot at mount: the connect error shows instead of the body.
    await vi.waitFor(() => expect(host.textContent).toContain('Could not connect'));
    const demo = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('scripted demo'))!;
    await act(async () => {
      demo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="room-transcript"]')).not.toBeNull());

    // The column that carries `paddingRight: panelClearance`, around the transcript.
    const column = host.querySelector<HTMLElement>('[data-testid="room-transcript"]')!.closest<HTMLElement>(
      '[style*="padding-right"]'
    )!;
    expect(column).not.toBeNull();
    await vi.waitFor(() => expect(column.style.paddingRight).toBe('0px'));
    expect(column.getBoundingClientRect().width).toBeGreaterThan(1000);
  });

  // Calm Room open: while bootstrapping, a calm shimmer skeleton stands in
  // for the transcript — never the agent-state dot matrix (that's for agent
  // states only, see the "polish" brief).
  it('shows three calm skeleton rows while the room is still opening, not the dot matrix', async () => {
    await act(async () => {
      root.render(<RoomLoadingSkeleton />);
    });
    const skeleton = host.querySelector('[data-testid="room-loading-skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(3);
    expect(skeleton?.querySelector('[data-state]')).toBeNull(); // no DotMatrix here
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

describe('Room composer — a plain reply to your own agent', () => {
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

  const turn = { id: 'msg-turn', authorId: 'bob', label: 'Your Claude', excerpt: 'Linear it is — say the word and I file it' };

  /** Answers like the relay would: sure about "ok not this one", unsure about anything else. */
  function suggester() {
    return vi.fn(async (draft: string): Promise<ComposerSuggestion | null> =>
      /^(hey claude, )?ok not this one/.test(draft)
        ? { agent: 'claude', replyTo: turn, confidence: 0.8 }
        : { agent: 'claude', replyTo: turn, confidence: 0.3 }
    );
  }

  /** The Room's settings api, so any pickers a pill has would show (and load). */
  const settingsLoad = vi.fn(async () => ({
    model: { selected: 'default', options: [{ id: 'default', name: 'Opus (1M context)' }] },
    effort: null,
    mode: { selected: 'default', options: [{ id: 'default', name: 'Manual' }] },
  }));
  const settingsApi: AgentSettingsApi = { load: settingsLoad, change: async () => ({ error: 'not in this test' }) };

  async function renderComposer(
    suggestReply: ReturnType<typeof suggester>,
    sent: Array<[string, unknown]> = [],
    replyTo: typeof turn | null = null,
    agents?: RoomSnapshot['agents']
  ) {
    const snapshot = replayedSnapshot();
    const own = agents ?? snapshot.agents.filter((a) => a.owner === 'bob');
    settingsLoad.mockClear();
    await act(async () => {
      root.render(
        <AgentSettingsContext.Provider value={settingsApi}>
          <Composer
            spaceName={snapshot.name}
            members={snapshot.members}
            agents={own}
            skills={snapshot.skills}
            onSend={(text, context) => sent.push([text, context])}
            openDoc="docs/metrics.md"
            replyTo={replyTo}
            suggestReply={suggestReply}
          />
        </AgentSettingsContext.Provider>
      );
    });
    return host.querySelector<HTMLTextAreaElement>('textarea')!;
  }

  const ownPill = () => host.querySelector('[data-testid="composer-own-agent-pill"]');
  /** The "?" bubble's reason, as the pill's own Why button carries it. */
  const why = () => ownPill()?.querySelector('[data-testid="context-pill-why"]')?.getAttribute('aria-label');
  const replyReason = "Why: Looks like your answer to Claude's question, so it goes to Claude.";
  const agentPill = () => host.querySelector('[data-testid="composer-agent-pill"]');
  const replyPill = () => host.querySelector('[data-testid="composer-reply"]');
  const enter = (textarea: HTMLTextAreaElement) =>
    act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  const dismiss = () =>
    act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="composer-own-agent-pill"] [data-testid="context-pill-dismiss"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

  it('shows one pill, your agent and the turn it answers, once the relay is at least 0.5 sure', async () => {
    const suggestReply = suggester();
    const textarea = await renderComposer(suggestReply);

    await setTextareaValue(textarea, 'lunch at 1?');
    await vi.waitFor(() => expect(suggestReply).toHaveBeenCalledWith('lunch at 1?'));
    await new Promise((r) => setTimeout(r, 50));
    expect(host.querySelector('[data-testid="composer-pills"]')).toBeNull();

    await setTextareaValue(textarea, 'ok not this one');
    await vi.waitFor(() => expect(ownPill()?.textContent).toContain('Claude'));
    expect(ownPill()?.textContent).toContain('Linear it is — say the word and I file it');
    expect(ownPill()?.querySelector('svg.lucide-corner-up-left')).not.toBeNull();
    // The same glass pill as the others, with its liquid "?" and ×, and no line under it.
    expect(ownPill()?.classList.contains('context-pill')).toBe(true);
    expect(ownPill()?.parentElement?.getAttribute('data-testid')).toBe('composer-pills');
    expect(why()).toBe(replyReason);
    expect(ownPill()?.querySelector('[data-testid="context-pill-dismiss"]')?.getAttribute('aria-label')).toBe('Send to the chat');
    expect(host.querySelector('[data-testid="composer-own-agent-note"]')).toBeNull();
    expect(host.textContent).not.toContain('to send to the room');
    // One pill: no separate agent or reply pill, no doc pill.
    expect(agentPill()).toBeNull();
    expect(replyPill()).toBeNull();
    expect(host.querySelector('[data-testid="composer-doc-pill"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="context-pill-why"]')).toHaveLength(1);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Ask Claude'))).toBe(true);

    // Rewritten into something else: the guess goes at once, before any new answer.
    await setTextareaValue(textarea, 'lunch?');
    expect(ownPill()).toBeNull();
  });

  it('has no model, mode or effort pickers: the reply continues with your agent as it last ran', async () => {
    const textarea = await renderComposer(suggester());
    await setTextareaValue(textarea, 'ok not this one');
    await vi.waitFor(() => expect(ownPill()).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(host.querySelector('[data-testid="agent-settings"]')).toBeNull();
    expect(host.querySelector('[data-testid^="agent-setting-"]')).toBeNull();
    expect(settingsLoad).not.toHaveBeenCalled();
  });

  it('an explicit @claude still shows the agent pill with its pickers', async () => {
    const textarea = await renderComposer(suggester());
    await setTextareaValue(textarea, '@claude ok not this one');
    await vi.waitFor(() => expect(agentPill()?.querySelector('[data-testid="agent-setting-model"]')).not.toBeNull());
    expect(agentPill()?.querySelector('[data-testid="agent-setting-mode"]')?.textContent).toContain('Manual');
    expect(settingsLoad).toHaveBeenCalled();
    expect(agentPill()?.textContent).toContain('Claude');
    expect(ownPill()).toBeNull();
  });

  it('Enter sends it to your agent as a reply to its turn', async () => {
    const sent: Array<[string, unknown]> = [];
    const textarea = await renderComposer(suggester(), sent);
    await setTextareaValue(textarea, 'ok not this one');
    await vi.waitFor(() => expect(ownPill()).not.toBeNull());
    await enter(textarea);
    expect(sent).toEqual([['ok not this one', { replyTo: turn, agent: 'claude', attach: null }]]);
  });

  it('× drops the guess for this draft, and the message goes to the room as plain chat', async () => {
    const sent: Array<[string, unknown]> = [];
    const suggestReply = suggester();
    const textarea = await renderComposer(suggestReply, sent);
    await setTextareaValue(textarea, 'ok not this one');
    await vi.waitFor(() => expect(ownPill()).not.toBeNull());
    await dismiss();
    expect(ownPill()).toBeNull();

    // Typing on doesn't bring it back for this draft.
    const calls = suggestReply.mock.calls.length;
    await setTextareaValue(textarea, 'ok not this one, the other');
    await new Promise((r) => setTimeout(r, 700));
    expect(suggestReply.mock.calls.length).toBe(calls);
    expect(ownPill()).toBeNull();

    await enter(textarea);
    expect(sent).toEqual([['ok not this one, the other', { replyTo: undefined, agent: null, attach: null }]]);
  });

  it('never asks while the draft has an @mention', async () => {
    const suggestReply = suggester();
    const textarea = await renderComposer(suggestReply);
    await setTextareaValue(textarea, '@claude ok not this one');
    await setTextareaValue(textarea, 'ok not this one @Alice');
    await new Promise((r) => setTimeout(r, 700));
    expect(suggestReply).not.toHaveBeenCalled();
  });

  it('never asks once you chose a Reply yourself, and keeps that Reply pill', async () => {
    const suggestReply = suggester();
    const textarea = await renderComposer(suggestReply, [], { ...turn, id: 'msg-other', label: 'Alice' });
    await setTextareaValue(textarea, 'ok not this one');
    await new Promise((r) => setTimeout(r, 700));
    expect(suggestReply).not.toHaveBeenCalled();
    expect(ownPill()).toBeNull();
    expect(replyPill()?.textContent).toContain('Replying to');
    expect(replyPill()?.textContent).toContain('Alice');
  });

  it('still shows the pill when the relay answers seconds later, as long as it is the same draft', async () => {
    let answer: (s: ComposerSuggestion) => void = () => {};
    const suggestReply = vi.fn(() => new Promise<ComposerSuggestion | null>((resolve) => (answer = resolve)));
    const textarea = await renderComposer(suggestReply as unknown as ReturnType<typeof suggester>);
    await setTextareaValue(textarea, 'ok not this one');
    await vi.waitFor(() => expect(suggestReply).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 300));
    expect(ownPill()).toBeNull();
    await act(async () => answer({ agent: 'claude', replyTo: turn, confidence: 0.98 }));
    expect(ownPill()?.textContent).toContain('Claude');
    expect(ownPill()?.textContent).toContain('Linear it is');
  });

  describe('calling your agent by name', () => {
    const neverSure = () => vi.fn(async (): Promise<ComposerSuggestion | null> => null);
    const withCodex = () => {
      const own = replayedSnapshot().agents.filter((a) => a.owner === 'bob');
      return [...own, { ...own[0]!, agent: 'codex' as const }];
    };

    it.each([
      ["hey claude what's up?", 'Claude', 'claude'],
      ['Claude, can you check the churn row?', 'Claude', 'Claude'],
      ['codex: summarize', 'Codex', 'codex'],
    ])('"%s" shows the one pill for %s, with no reply target', async (draft, name, word) => {
      const textarea = await renderComposer(neverSure(), [], null, withCodex());
      await setTextareaValue(textarea, draft);
      expect(ownPill()?.querySelector('b')?.textContent).toBe(name);
      expect(ownPill()?.querySelector('.truncate')).toBeNull();
      expect(ownPill()?.classList.contains('context-pill')).toBe(true);
      expect(ownPill()?.querySelector('svg.lucide-corner-up-left')).toBeNull();
      expect(why()).toBe(`Why: You started with "${word}", so it goes to ${name}.`);
      expect(agentPill()).toBeNull();
      expect(host.querySelector('[data-testid="agent-settings"]')).toBeNull();
    });

    it.each([["I asked claude yesterday"], ['claudette is here'], ["claude's answer was off"], ['codex: summarize']])(
      '"%s" shows nothing (not calling one of your agents)',
      async (draft) => {
        // Bob has no Codex of his own here: Alice's isn't his to call.
        const textarea = await renderComposer(neverSure());
        await setTextareaValue(textarea, draft);
        await new Promise((r) => setTimeout(r, 50));
        expect(ownPill()).toBeNull();
        expect(host.querySelector('[data-testid="composer-pills"]')).toBeNull();
      }
    );

    it('Enter sends to that agent exactly like an @claude send', async () => {
      const sent: Array<[string, unknown]> = [];
      const textarea = await renderComposer(neverSure(), sent);
      await setTextareaValue(textarea, "hey claude what's up?");
      expect([...host.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Ask Claude'))).toBe(true);
      await enter(textarea);
      expect(sent).toEqual([["hey claude what's up?", { replyTo: undefined, agent: 'claude', attach: null }]]);
    });

    it('× sticks for the rest of the draft', async () => {
      const sent: Array<[string, unknown]> = [];
      const textarea = await renderComposer(neverSure(), sent);
      await setTextareaValue(textarea, 'claude, can you');
      await dismiss();
      expect(ownPill()).toBeNull();
      await setTextareaValue(textarea, 'claude, can you look at this?');
      expect(ownPill()).toBeNull();
      await enter(textarea);
      expect(sent).toEqual([['claude, can you look at this?', { replyTo: undefined, agent: null, attach: null }]]);
      // A fresh draft starts clean.
      await setTextareaValue(textarea, 'claude, one more');
      expect(ownPill()).not.toBeNull();
    });

    it('a reply the relay is sure of wins over the name (it carries the turn)', async () => {
      const sent: Array<[string, unknown]> = [];
      const textarea = await renderComposer(suggester(), sent);
      await setTextareaValue(textarea, 'hey claude, ok not this one');
      expect(why()).toBe('Why: You started with "claude", so it goes to Claude.');
      await vi.waitFor(() => expect(why()).toBe(replyReason));
      expect(ownPill()?.textContent).toContain('Linear it is');
      expect(host.querySelectorAll('[data-testid="composer-own-agent-pill"]')).toHaveLength(1);
      await enter(textarea);
      expect(sent).toEqual([['hey claude, ok not this one', { replyTo: turn, agent: 'claude', attach: null }]]);
    });
  });

  it('files the agent request with the reply on the message, marked as asked, and changes no settings', async () => {
    const calls: unknown[] = [];
    const source = {
      send: vi.fn(async (...args: unknown[]) => {
        calls.push(['send', ...args]);
        return 'msg-new';
      }),
      requestOwnAgent: vi.fn(async (...args: unknown[]) => {
        calls.push(['requestOwnAgent', ...args]);
      }),
    };
    const wake = vi.fn();
    await sendFromComposer(source, ['claude'], 'ok not this one', { replyTo: turn, agent: 'claude', attach: null }, wake);
    // Just the message and the request: nothing sets a model, mode or effort,
    // so the turn runs in your agent's session as its last turn did.
    expect(calls).toEqual([
      ['send', 'ok not this one', turn, 'claude'],
      ['requestOwnAgent', 'claude', 'ok not this one', 'msg-new'],
    ]);
    expect(wake).toHaveBeenCalledOnce();

    // Dropped pill: plain chat, no request, no mark.
    calls.length = 0;
    await sendFromComposer(source, ['claude'], 'ok not this one', { replyTo: undefined, agent: null, attach: null }, wake);
    expect(calls).toEqual([['send', 'ok not this one', undefined, undefined]]);
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
          <AgentRows snapshot={snapshot} selfUserId="bob" bindingId="space-agents-model" />
        </AgentSettingsContext.Provider>
      );
    });
    // Collapsed by default — expand the summary row before reaching in.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="agents-summary-row"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

  it('collapses Agents behind a summary row by default (with a logo stack), expands in place, and remembers that per space', async () => {
    const api: AgentSettingsApi = {
      load: async () => ({ model: { selected: 'default', options: [] }, effort: null, mode: { selected: 'default', options: [] } }),
      change: async () => ({ error: 'unused' }),
    };
    const snapshot = replayedSnapshot();
    const render = () =>
      act(async () => {
        root.render(
          <AgentSettingsContext.Provider value={api}>
            <AgentRows snapshot={snapshot} selfUserId="bob" bindingId="space-agents-collapse" />
          </AgentSettingsContext.Provider>
        );
      });
    await render();

    const summary = host.querySelector<HTMLButtonElement>('[data-testid="agents-summary-row"]')!;
    expect(summary.textContent).toContain('Agents');
    // A stack of the agents' own marks (brand SVGs with an owner badge) stands in for the rows.
    expect(host.querySelector('[data-testid="agents-avatar-stack"]')).not.toBeNull();
    expect(summary.querySelectorAll('svg').length).toBeGreaterThan(0);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-testid="space-agent-row"]')).toBeNull();
    expect(host.querySelector('[data-testid="space-agent-row-theirs"]')).toBeNull();

    await act(async () => summary.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-testid="space-agent-row"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="space-agent-row-theirs"]')).not.toBeNull();
    // Once expanded, the rows below already say who's who — the summary's
    // own logo stack (unlike its Bot/Chevron icons) is redundant now, same
    // rule as the Connectors row's logos.
    expect(host.querySelector('[data-testid="agents-avatar-stack"]')).toBeNull();

    // Remounted against the same space: still expanded (remembered in localStorage).
    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await render();
    expect(host.querySelector('[data-testid="space-agent-row"]')).not.toBeNull();
  });

  it("shows a quiet phantom instead of a blank label for another owner's agent whose run hasn't reported a model yet", async () => {
    // `theirs` only ever holds agents with at least one run in this space,
    // so a run whose meta model is 'unknown' and whose event log hasn't
    // reported one either is exactly "just started, still loading" — not a
    // permanently-empty state.
    const loadingMeta: SessionRunMeta = {
      id: 'run-loading',
      agent: 'claude',
      owner: 'alice',
      model: 'unknown',
      title: '',
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(
        <AgentRows
          snapshot={{
            ...snapshot,
            sessionMetaByRun: { ...snapshot.sessionMetaByRun, 'run-loading': loadingMeta },
            sessionEventsByRun: { ...snapshot.sessionEventsByRun, 'run-loading': [] },
          }}
          selfUserId="bob"
          bindingId="space-agents-phantom"
        />
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="agents-summary-row"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const theirsRows = [...host.querySelectorAll<HTMLElement>('[data-testid="space-agent-row-theirs"]')];
    // Alice only ever owns codex runs in the base fixture — this Claude row
    // is exclusively the one just injected above.
    const loadingRow = theirsRows.find((row) => row.title === "Only Alice can change Alice's Claude");
    expect(loadingRow).toBeTruthy();
    // No blank/stale text — a quiet shimmer phantom instead (the dot matrix
    // is for agent states only; a settings phantom isn't one — see the
    // "polish" brief's "dot-matrix loader is for agent states only").
    expect(loadingRow!.querySelector('[data-testid="agent-model-loading"]')).not.toBeNull();
    expect(loadingRow!.textContent?.trim().endsWith("Alice's Claude")).toBe(true);
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
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  /** Opens the collapsed section — every test below needs its rows visible. */
  const openConnectors = () => act(async () => click(host.querySelector('[data-testid="connectors-summary-row"]')!));

  it('shows the empty state, and the Add pill only for a member who can write', async () => {
    const snapshot = connectorsSnapshot();
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" bindingId="space-connectors-empty" />);
    });
    await openConnectors();
    expect(host.querySelector('[data-testid="connectors-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="connectors-add-toggle"]')).not.toBeNull();

    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="sam" bindingId="space-connectors-empty" />);
    });
    expect(host.querySelector('[data-testid="connectors-add-toggle"]')).toBeNull();
  });

  it('renders each connector as a single row (a button): logo, name, and a compact status — no sub-labels, no hover pills', async () => {
    const snapshot = connectorsSnapshot({
      connectors: [
        { id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' },
        { id: 'notion', name: 'Notion', addedBy: 'sam', mine: 'not_connected' },
        { id: 'sentry', name: 'Sentry', addedBy: 'dylan', mine: 'expired' },
      ],
    });
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" bindingId="space-connectors-rows" />);
    });
    await openConnectors();
    const rowFor = (id: string) => host.querySelector<HTMLElement>(`[data-testid="connector-row"][data-connector="${id}"]`)!;

    // Every row is itself a button — no nested action pills, no menu.
    expect(rowFor('linear').tagName).toBe('BUTTON');
    expect(rowFor('linear').querySelectorAll('button')).toHaveLength(0);

    expect(rowFor('linear').textContent).toContain('Connected');
    expect(rowFor('linear').textContent).not.toContain('Added by');
    expect(rowFor('linear').querySelector('.bg-success')).not.toBeNull();

    expect(rowFor('notion').textContent).toContain('Connect');
    expect(rowFor('notion').textContent).not.toContain('Added by');

    expect(rowFor('sentry').textContent).toContain('Reconnect');
  });

  it('says "Via Claude" for a connector your agent already reaches globally, and drops it from the to-connect count', async () => {
    const snapshot = connectorsSnapshot({
      connectors: [
        { id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'not_connected' },
        { id: 'notion', name: 'Notion', addedBy: 'dylan', mine: 'not_connected' },
      ],
    });
    const globalSetup: GlobalServer[] = [
      { agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
    ];
    await act(async () => {
      root.render(
        <ConnectorsSection
          snapshot={snapshot}
          selfUserId="dylan"
          bindingId="space-connectors-global"
          globalSetup={globalSetup}
        />
      );
    });
    // Collapsed: only Notion counts — Linear's rig connection isn't needed.
    expect(host.querySelector('[data-testid="connectors-summary-row"]')?.textContent).toContain('1 to connect');

    await openConnectors();
    const rowFor = (id: string) => host.querySelector<HTMLElement>(`[data-testid="connector-row"][data-connector="${id}"]`)!;
    expect(rowFor('linear').textContent).toContain('Via Claude');
    expect(rowFor('notion').textContent).toContain('Connect');
    // The logo carries a small "via Claude" badge in this state, but not once it's a real connection.
    expect(rowFor('linear').querySelector('[data-testid="connector-via-badge"]')).not.toBeNull();
    expect(rowFor('notion').querySelector('[data-testid="connector-via-badge"]')).toBeNull();
    // The compact status stays "Via Claude"; the full sentence is in the row's own tooltip.
    expect(rowFor('linear').title).toBe('Via your Claude setup');
  });

  it('shows the account in the row\'s tooltip once connected, falling back to "you"', async () => {
    const snapshot = connectorsSnapshot({
      connectors: [
        { id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected', account: 'dtsbourg@gmail.com' },
        { id: 'notion', name: 'Notion', addedBy: 'dylan', mine: 'connected' },
      ],
    });
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" bindingId="space-connectors-account" />);
    });
    await openConnectors();
    const rowFor = (id: string) => host.querySelector<HTMLElement>(`[data-testid="connector-row"][data-connector="${id}"]`)!;
    // Compact status keeps saying "Connected" — the account lives in the tooltip.
    expect(rowFor('linear').textContent).toContain('Connected');
    expect(rowFor('linear').textContent).not.toContain('dtsbourg@gmail.com');
    expect(rowFor('linear').title).toBe('Connected as dtsbourg@gmail.com');
    expect(rowFor('notion').title).toBe('Connected as you');
    // A real connection never shows the via-setup badge.
    expect(rowFor('linear').querySelector('[data-testid="connector-via-badge"]')).toBeNull();
  });

  it('opens the gallery straight on a connector\'s detail view when its row is clicked', async () => {
    const onOpenGallery = vi.fn();
    const snapshot = connectorsSnapshot({
      connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }],
    });
    await act(async () => {
      root.render(
        <ConnectorsSection snapshot={snapshot} selfUserId="dylan" bindingId="space-connectors-open" onOpenGallery={onOpenGallery} />
      );
    });
    await openConnectors();
    await act(async () => click(host.querySelector('[data-testid="connector-row"][data-connector="linear"]')!));
    expect(onOpenGallery).toHaveBeenCalledWith('linear');
  });

  it('shows the collapsed "Your agents also bring N connectors" line, which opens the gallery (unfocused) when clicked', async () => {
    const onOpenGallery = vi.fn();
    const globalSetup: GlobalServer[] = [
      { agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
      { agent: 'codex', name: 'launchdarkly', url: null, connectorId: null },
    ];
    await act(async () => {
      root.render(
        <ConnectorsSection
          snapshot={connectorsSnapshot()}
          selfUserId="dylan"
          bindingId="space-connectors-global-line"
          globalSetup={globalSetup}
          onOpenGallery={onOpenGallery}
        />
      );
    });
    await openConnectors();
    const line = host.querySelector<HTMLButtonElement>('[data-testid="global-setup-line"]')!;
    expect(line.textContent).toContain('Your agents also bring 2 connectors from their own setup');
    await act(async () => click(line));
    expect(onOpenGallery).toHaveBeenCalledWith();
  });

  it('collapses behind a summary row by default — stacked logos, a count, a quiet hint when action is needed — and remembers it open per space', async () => {
    const snapshot = connectorsSnapshot({
      connectors: [
        { id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' },
        { id: 'notion', name: 'Notion', addedBy: 'dylan', mine: 'expired' },
      ],
    });
    const render = (bindingId: string) =>
      act(async () => {
        root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" bindingId={bindingId} />);
      });
    await render('space-connectors-collapse-1');

    const summary = host.querySelector<HTMLButtonElement>('[data-testid="connectors-summary-row"]')!;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.textContent).toContain('Connectors');
    expect(summary.textContent).toContain('2'); // the count
    expect(summary.textContent).toContain('1 to connect'); // Notion's expired login
    expect(summary.querySelectorAll('svg').length).toBeGreaterThan(0); // the logo stack
    expect(host.querySelector('[data-testid="connector-row"]')).toBeNull();

    await act(async () => click(summary));
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('[data-testid="connector-row"]')).toHaveLength(2);

    // Remounted against the same space: still expanded.
    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await render('space-connectors-collapse-1');
    expect(host.querySelectorAll('[data-testid="connector-row"]')).toHaveLength(2);

    // A different space starts fresh, collapsed.
    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await render('space-connectors-collapse-2');
    expect(host.querySelector('[data-testid="connector-row"]')).toBeNull();
  });

  it('"+ Add" opens the tool gallery unfocused, straight to the grid', async () => {
    const onOpenGallery = vi.fn();
    await act(async () => {
      root.render(
        <ConnectorsSection
          snapshot={connectorsSnapshot()}
          selfUserId="dylan"
          bindingId="space-connectors-add"
          onOpenGallery={onOpenGallery}
        />
      );
    });
    await openConnectors();
    await act(async () => click(host.querySelector('[data-testid="connectors-add-toggle"]')!));
    expect(onOpenGallery).toHaveBeenCalledWith();
  });

  it('the "your agents also bring" line opens their own connectors, not the Add grid', async () => {
    const onOpenGallery = vi.fn();
    const onOpenGlobalSetup = vi.fn();
    await act(async () => {
      root.render(
        <ConnectorsSection
          snapshot={connectorsSnapshot()}
          selfUserId="dylan"
          bindingId="space-connectors-setup-line"
          onOpenGallery={onOpenGallery}
          onOpenGlobalSetup={onOpenGlobalSetup}
          globalSetup={[{ agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' }]}
        />
      );
    });
    await openConnectors();
    await act(async () => click(host.querySelector('[data-testid="global-setup-line"]')!));
    expect(onOpenGlobalSetup).toHaveBeenCalledTimes(1);
    expect(onOpenGallery).not.toHaveBeenCalled();
  });
});

describe('Connectors — gallery', () => {
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

  const cardOf = (id: string) => host.querySelector<HTMLElement>(`[data-testid="gallery-card"][data-connector="${id}"]`)!;
  const buttonIn = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label)!;
  const detail = () => host.querySelector<HTMLElement>('[data-testid="gallery-detail"]')!;

  const renderGallery = async (
    snapshot = connectorsSnapshot(),
    source = fakeConnectorsSource(),
    onClose = vi.fn(),
    extra: {
      selfUserId?: string;
      focus?: ConnectorId | null;
      globalSetup?: GlobalServer[];
      initialScope?: 'all' | 'installed' | 'available';
      initialSection?: 'global-setup' | null;
    } = {}
  ) => {
    await act(async () => {
      root.render(
        <ConnectorGallery
          snapshot={snapshot}
          selfUserId={extra.selfUserId ?? 'dylan'}
          source={source}
          onClose={onClose}
          rightInset={320}
          globalSetup={extra.globalSetup}
          focus={extra.focus}
          initialScope={extra.initialScope}
          initialSection={extra.initialSection}
        />
      );
    });
    return { source, onClose };
  };

  it('groups connectors: in this space (with your state), ones you can add, and ones coming soon', async () => {
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] })
    );
    const headings = [...host.querySelectorAll('h3')].map((h) => h.textContent);
    expect(headings).toEqual(['In this space', 'Add to this space', 'Coming soon']);
    expect(cardOf('linear').textContent).toContain('Connected as you');
    expect(buttonIn(cardOf('posthog'), 'Add')).toBeTruthy();
    expect(host.querySelectorAll('[data-testid="gallery-soon"]').length).toBeGreaterThan(0);
  });

  it('clicking a card (not its Add button) opens the detail view, hiding search and the category chips', async () => {
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] })
    );
    await act(async () => click(cardOf('linear')));
    expect(detail().getAttribute('data-connector')).toBe('linear');
    expect(detail().textContent).toContain('Connected as you');
    expect(host.querySelector('[data-testid="gallery-search"]')).toBeNull();
  });

  it('"← All connectors" returns from the detail view to the grid', async () => {
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] })
    );
    await act(async () => click(cardOf('linear')));
    await act(async () => click(host.querySelector('[data-testid="gallery-detail-back"]')!));
    expect(host.querySelector('[data-testid="gallery-detail"]')).toBeNull();
    expect(host.querySelector('[data-testid="gallery-search"]')).not.toBeNull();
  });

  it('opens straight on a connector\'s detail view when `focus` is set (a space panel row was clicked)', async () => {
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] }),
      fakeConnectorsSource(),
      vi.fn(),
      { focus: 'linear' }
    );
    expect(detail().getAttribute('data-connector')).toBe('linear');
  });

  it('detail view shows the big logo, name, blurb, category, your state, and who added it', async () => {
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'sam', mine: 'not_connected' }] })
    );
    await act(async () => click(cardOf('linear')));
    expect(detail().querySelector('svg')).not.toBeNull();
    expect(detail().textContent).toContain('Linear');
    expect(detail().textContent).toContain('Issues, projects, cycles');
    expect(detail().textContent).toContain('Work tracking');
    expect(detail().textContent).toContain('Not connected');
    expect(detail().textContent).toContain('Added by Sam');
  });

  it('says "Added by you" when you added it yourself, and shows "Login expired" with the amber Reconnect action', async () => {
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'expired' }] })
    );
    await act(async () => click(cardOf('linear')));
    expect(detail().textContent).toContain('Added by you');
    expect(detail().textContent).toContain('Login expired');
    expect(buttonIn(detail(), 'Reconnect')).toBeTruthy();
  });

  it('Connect on the detail view shows the consent line, then waits for the browser, and Cancel aborts it', async () => {
    const inFlight: { settle: ((r: ConnectResult) => void) | null } = { settle: null };
    vi.mocked(connectorsApi.connect).mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight.settle = resolve;
        })
    );
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'not_connected' }] })
    );
    await act(async () => click(cardOf('linear')));
    await act(async () => click(buttonIn(detail(), 'Connect')));
    expect(detail().querySelector('[data-testid="gallery-detail-consent"]')?.textContent).toContain(
      'sign in to Linear in your browser'
    );
    await act(async () => click(buttonIn(detail(), 'Continue in browser')));
    expect(detail().textContent).toContain('Waiting for your browser');
    // The dot matrix is for agent states only — a browser sign-in wait gets
    // a plain spinner instead (see the "polish" brief).
    expect(detail().querySelector('[data-state]')).toBeNull();
    expect(detail().querySelector('.animate-spin')).not.toBeNull();

    await act(async () => click(buttonIn(detail(), 'Cancel')));
    expect(connectorsApi.cancel).toHaveBeenCalledWith('linear');
    expect(detail().textContent).not.toContain('Waiting for your browser');
    inFlight.settle?.({ ok: true }); // let the abandoned promise settle so it doesn't dangle
  });

  it('Add on a not-yet-added card opens its detail already mid-flow; connecting adds it to the space', async () => {
    const { source } = await renderGallery();
    await act(async () => click(buttonIn(cardOf('posthog'), 'Add')));
    expect(detail().getAttribute('data-connector')).toBe('posthog');
    expect(detail().querySelector('[data-testid="gallery-detail-consent"]')).not.toBeNull();
    await act(async () => click(buttonIn(detail(), 'Continue in browser')));
    await vi.waitFor(() => expect(connectorsApi.connect).toHaveBeenCalledWith('posthog'));
    await vi.waitFor(() => expect(source.addConnector).toHaveBeenCalledWith('posthog'));
  });

  it('adds a tool you are already connected to straight away, no sign-in and no detour through the detail view', async () => {
    vi.mocked(connectorsApi.list).mockResolvedValue([{ id: 'sentry', state: 'connected' }]);
    const { source } = await renderGallery();
    await vi.waitFor(() => expect(connectorsApi.list).toHaveBeenCalled());
    await act(async () => click(buttonIn(cardOf('sentry'), 'Add')));
    await vi.waitFor(() => expect(source.addConnector).toHaveBeenCalledWith('sentry'));
    expect(connectorsApi.connect).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="gallery-detail"]')).toBeNull();
  });

  it('"Disconnect" clears your connection, no confirm needed', async () => {
    const { source } = await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] })
    );
    await act(async () => click(cardOf('linear')));
    await act(async () => click(buttonIn(detail(), 'Disconnect')));
    expect(connectorsApi.disconnect).toHaveBeenCalledWith('linear');
    await vi.waitFor(() => expect(source.refreshConnections).toHaveBeenCalled());
  });

  it('"Remove from space" needs a second click to confirm, then removes it for everyone', async () => {
    const { source } = await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] })
    );
    await act(async () => click(cardOf('linear')));
    const removeButton = () => [...detail().querySelectorAll('button')].find((b) => b.textContent?.startsWith('Remove'))!;
    await act(async () => click(removeButton()));
    expect(removeButton().textContent).toBe('Remove for everyone?');
    expect(source.removeConnector).not.toHaveBeenCalled();
    await act(async () => click(removeButton()));
    expect(source.removeConnector).toHaveBeenCalledWith('linear');
  });

  it('does not offer "Remove from space" to a member who cannot write', async () => {
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] }),
      fakeConnectorsSource(),
      vi.fn(),
      { selfUserId: 'sam' }
    );
    await act(async () => click(cardOf('linear')));
    expect([...detail().querySelectorAll('button')].some((b) => b.textContent?.includes('Remove'))).toBe(false);
  });

  it('filters by search and by category', async () => {
    await renderGallery();
    const search = host.querySelector<HTMLInputElement>('[data-testid="gallery-search"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'funnel');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const ids = () => [...host.querySelectorAll('[data-testid="gallery-card"]')].map((c) => c.getAttribute('data-connector'));
    expect(ids()).toEqual(['mixpanel']);

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => click(buttonIn(host, 'Analytics')));
    expect(ids()).toEqual(['posthog', 'amplitude', 'mixpanel']);
  });

  it('closes on Escape and on the backdrop', async () => {
    const { onClose } = await renderGallery();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => click(host.querySelector('[data-testid="gallery-backdrop"]')!));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('notes a catalog connector your agents already have globally in the card footer, and clarifies what Add does', async () => {
    const globalSetup: GlobalServer[] = [
      { agent: 'claude', name: 'claude.ai PostHog', url: 'https://mcp.posthog.com/mcp', connectorId: 'posthog' },
    ];
    await renderGallery(connectorsSnapshot(), fakeConnectorsSource(), vi.fn(), { globalSetup });
    expect(cardOf('posthog').textContent).toContain('Your Claude has it · add for everyone');
    // The logo carries a small "via Claude" badge in this state.
    expect(cardOf('posthog').querySelector('[data-testid="connector-via-badge"]')).not.toBeNull();
    // The Add pill explains itself: adding shares it with the whole space.
    expect(buttonIn(cardOf('posthog'), 'Add').title).toContain('everyone');
    // A connector none of your agents have keeps its plain category label and no badge.
    expect(cardOf('linear').textContent).toContain('Work tracking');
    expect(cardOf('linear').querySelector('[data-testid="connector-via-badge"]')).toBeNull();
  });

  it('shows the "From your agents\' own setup" section as cards: a cleaned name (raw name kept in a title), a real logo when it matches the catalog, a neutral tile when it doesn\'t, and merged agents for the same catalog connector', async () => {
    const globalSetup: GlobalServer[] = [
      { agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
      { agent: 'codex', name: 'Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
      { agent: 'codex', name: 'plugin:acme-tools:launchdarkly', url: null, connectorId: null },
    ];
    await renderGallery(connectorsSnapshot(), fakeConnectorsSource(), vi.fn(), { globalSetup });
    const section = host.querySelector('[data-testid="gallery-global-setup"]')!;
    const cards = [...section.querySelectorAll<HTMLElement>('[data-testid="gallery-setup-card"]')];
    expect(cards).toHaveLength(2);

    const linearCard = cards.find((c) => c.textContent?.includes('Linear'))!;
    expect(linearCard.textContent).toContain('In your Claude and Codex setup');
    expect(linearCard.querySelector('b')?.getAttribute('title')).toBe('claude.ai Linear');
    expect(linearCard.querySelector('svg')).not.toBeNull();
    expect(linearCard.getAttribute('data-connector')).toBe('linear');

    const ldCard = cards.find((c) => c.textContent?.includes('launchdarkly'))!;
    expect(ldCard.textContent).toContain('launchdarkly');
    expect(ldCard.textContent).not.toContain('plugin:');
    expect(ldCard.textContent).toContain('In your Codex setup');
    // No catalog match: a neutral plug tile, and not clickable — nothing to open.
    expect(ldCard.querySelector('svg.lucide-plug')).not.toBeNull();
    expect(ldCard.getAttribute('data-connector')).toBeNull();
    expect(ldCard.getAttribute('role')).toBeNull();
  });

  it('opens a matched global-setup card straight to that connector\'s detail view', async () => {
    const globalSetup: GlobalServer[] = [
      { agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
    ];
    await renderGallery(connectorsSnapshot(), fakeConnectorsSource(), vi.fn(), { globalSetup });
    const card = host.querySelector<HTMLElement>('[data-testid="gallery-setup-card"][data-connector="linear"]')!;
    await act(async () => click(card));
    expect(detail().getAttribute('data-connector')).toBe('linear');
  });

  it('draws a real brand mark for a Simple Icons connector, and the letter tile for one with no vector mark', async () => {
    await renderGallery();
    expect(cardOf('linear').querySelector('svg')).not.toBeNull();
    expect(cardOf('amplitude').querySelector('svg')).toBeNull();
    expect(cardOf('amplitude').querySelector('span[aria-hidden]')?.textContent).toBe('A');
  });

  it('keeps the scope and category filters on one line that never wraps, with no visible scrollbar over the chips', async () => {
    await renderGallery();
    const row = host.querySelector('[data-testid="gallery-filters"]')!;
    expect(row.className).not.toContain('flex-wrap');
    expect(buttonIn(row, 'All')).toBeTruthy();
    expect(buttonIn(row, 'Installed')).toBeTruthy();
    expect(buttonIn(row, 'Available')).toBeTruthy();
    // The row scrolls, but its own scrollbar never overlaps the chips.
    expect(row.className).toContain('overflow-x-auto');
    expect(row.className).toContain('[scrollbar-width:none]');
  });

  it('scope "Installed" keeps what\'s in the space plus what your agents already reach on their own; "Available" drops what\'s already in the space', async () => {
    const globalSetup: GlobalServer[] = [
      { agent: 'claude', name: 'claude.ai PostHog', url: 'https://mcp.posthog.com/mcp', connectorId: 'posthog' },
    ];
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] }),
      fakeConnectorsSource(),
      vi.fn(),
      { globalSetup }
    );
    const ids = () => [...host.querySelectorAll('[data-testid="gallery-card"]')].map((c) => c.getAttribute('data-connector'));

    await act(async () => click(buttonIn(host, 'Installed')));
    expect(ids().sort()).toEqual(['linear', 'posthog']);
    // Nothing to add and nothing coming soon under "Installed".
    expect(host.querySelectorAll('[data-testid="gallery-soon"]').length).toBe(0);

    await act(async () => click(buttonIn(host, 'Available')));
    expect(ids()).not.toContain('linear');
    expect(ids()).toContain('posthog');

    await act(async () => click(buttonIn(host, 'All')));
    expect(ids()).toContain('linear');
  });

  it('shows "From your agents\' own setup" under "All" and "Installed", not under "Available"', async () => {
    const globalSetup: GlobalServer[] = [
      { agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
    ];
    await renderGallery(connectorsSnapshot(), fakeConnectorsSource(), vi.fn(), { globalSetup });
    expect(host.querySelector('[data-testid="gallery-global-setup"]')).not.toBeNull();
    await act(async () => click(buttonIn(host, 'Installed')));
    expect(host.querySelector('[data-testid="gallery-global-setup"]')).not.toBeNull();
    await act(async () => click(buttonIn(host, 'Available')));
    expect(host.querySelector('[data-testid="gallery-global-setup"]')).toBeNull();
  });

  it('opens scrolled to "From your agents\' own setup" and scoped to Installed when asked to (the panel\'s "also bring" line)', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const globalSetup: GlobalServer[] = [
      { agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
    ];
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] }),
      fakeConnectorsSource(),
      vi.fn(),
      { globalSetup, initialScope: 'installed', initialSection: 'global-setup' }
    );
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    // Scoped to "Installed" from the start: "Coming soon" (never installed, never yours) is hidden.
    expect(host.querySelectorAll('[data-testid="gallery-soon"]').length).toBe(0);
    expect(host.querySelector('[data-testid="gallery-global-setup"]')).not.toBeNull();
    scrollSpy.mockRestore();
  });

  it('detail\'s Details section shows which of your agents can reach it, plus the connector\'s MCP host', async () => {
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }] })
    );
    await act(async () => click(cardOf('linear')));
    // A space connector is wired into any of your agents' sessions.
    expect(detail().textContent).toContain('Available to');
    expect(detail().textContent).toContain('Claude, Codex');
    expect(detail().textContent).toContain('Server');
    expect(detail().textContent).toContain('mcp.linear.app');
  });

  it('detail\'s Details section names just the one agent for a connector only reached via its own global setup', async () => {
    const globalSetup: GlobalServer[] = [
      { agent: 'codex', name: 'claude.ai PostHog', url: 'https://mcp.posthog.com/mcp', connectorId: 'posthog' },
    ];
    await renderGallery(connectorsSnapshot(), fakeConnectorsSource(), vi.fn(), { globalSetup });
    await act(async () => click(cardOf('posthog')));
    expect(detail().textContent).toContain('Available to');
    expect(detail().textContent).toContain('Codex');
    expect(detail().textContent).toContain('mcp.posthog.com');
  });

  it('restructures the detail view into separate sections — Your connection, In this space, Details — instead of one big card', async () => {
    await renderGallery(
      connectorsSnapshot({ connectors: [{ id: 'linear', name: 'Linear', addedBy: 'sam', mine: 'not_connected' }] })
    );
    await act(async () => click(cardOf('linear')));
    const sections = [...detail().querySelectorAll('[data-testid="gallery-detail-section"] h4')].map((h) => h.textContent);
    expect(sections).toEqual(['Your connection', 'In this space', 'Details']);
    expect(host.querySelector('[data-testid="gallery-detail-status"]')).toBeNull();
  });

  it('shows the account when known, falling back to "you"', async () => {
    await renderGallery(
      connectorsSnapshot({
        connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected', account: 'dtsbourg@gmail.com' }],
      })
    );
    await act(async () => click(cardOf('linear')));
    expect(detail().textContent).toContain('Connected as dtsbourg@gmail.com');
  });

  it('puts the "via" badge on the detail header\'s logo too, while not personally connected', async () => {
    const globalSetup: GlobalServer[] = [
      { agent: 'codex', name: 'claude.ai PostHog', url: 'https://mcp.posthog.com/mcp', connectorId: 'posthog' },
    ];
    await renderGallery(connectorsSnapshot(), fakeConnectorsSource(), vi.fn(), { globalSetup });
    await act(async () => click(cardOf('posthog')));
    expect(detail().querySelector('[data-testid="connector-via-badge"]')).not.toBeNull();
  });

  it('drops the detail header\'s "via" badge once you\'re actually connected', async () => {
    const globalSetup: GlobalServer[] = [
      { agent: 'codex', name: 'claude.ai PostHog', url: 'https://mcp.posthog.com/mcp', connectorId: 'posthog' },
    ];
    vi.mocked(connectorsApi.list).mockResolvedValue([{ id: 'posthog', state: 'connected' }]);
    await renderGallery(connectorsSnapshot(), fakeConnectorsSource(), vi.fn(), { globalSetup, focus: 'posthog' });
    await vi.waitFor(() => expect(connectorsApi.list).toHaveBeenCalled());
    await vi.waitFor(() => expect(detail().textContent).toContain('Connected as you'));
    expect(detail().querySelector('[data-testid="connector-via-badge"]')).toBeNull();
  });

  it("badges every setup card on its tile's corner, a plain server's plug tile included", async () => {
    await renderGallery(connectorsSnapshot(), fakeConnectorsSource(), vi.fn(), {
      globalSetup: [
        { agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
        { agent: 'codex', name: 'grafana_prod', url: 'https://monitor.example/', connectorId: null },
      ],
    });
    const cards = [...host.querySelectorAll('[data-testid="gallery-setup-card"]')];
    expect(cards.length).toBe(2);
    for (const card of cards) expect(card.querySelector('[data-testid="connector-via-badge"]')).not.toBeNull();
  });

  it('offers one action for a connector not in the space yet: "Add to space" (which connects you as part of adding it)', async () => {
    await renderGallery();
    await act(async () => click(cardOf('posthog')));
    expect([...detail().querySelectorAll('button')].some((b) => b.textContent === 'Connect')).toBe(false);
    expect(buttonIn(detail(), 'Add to space')).toBeTruthy();
    expect(detail().textContent).toContain('Not in this space yet');
  });

  it('does not offer "Add to space" to a member who cannot write', async () => {
    await renderGallery(connectorsSnapshot(), fakeConnectorsSource(), vi.fn(), { selfUserId: 'sam' });
    await act(async () => click(cardOf('posthog')));
    expect([...detail().querySelectorAll('button')].some((b) => b.textContent === 'Add to space')).toBe(false);
    // A login only matters once the space uses the connector, so there's nothing to connect yet either.
    expect([...detail().querySelectorAll('button')].some((b) => b.textContent === 'Connect')).toBe(false);
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

  it('ConnectorCard\'s Connect pill waits with a plain spinner, not the agent dot matrix', async () => {
    const connectors: RoomConnector[] = [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'not_connected' }];
    let settle: ((r: ConnectResult) => void) | null = null;
    const onConnect = vi.fn().mockImplementation(() => new Promise<ConnectResult>((resolve) => (settle = resolve)));
    await act(async () => {
      root.render(<ConnectorCard message={connectorMessage} addedBy={undefined} connectors={connectors} onConnect={onConnect} />);
    });
    await act(async () => click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Connect')!));

    const waiting = host.querySelector('[data-testid="connect-pill-waiting"]');
    expect(waiting).not.toBeNull();
    expect(waiting?.textContent).toContain('Waiting for your browser');
    expect(waiting?.querySelector('[data-state]')).toBeNull(); // no DotMatrix here
    expect(waiting?.querySelector('.animate-spin')).not.toBeNull();

    await act(async () => settle?.({ ok: true }));
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

  it('drops a gap pill once you connect, and turns it into Reconnect when your login lapses', async () => {
    const render = (mine: RoomConnector['mine'] | null) =>
      act(async () => {
        root.render(
          <SessionCard
            meta={runMeta}
            events={gapEvents}
            owner={undefined}
            viewerIsOwner
            onConnectorConnect={vi.fn()}
            spaceConnectors={mine ? [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine }] : []}
          />
        );
      });
    await render('not_connected');
    expect(host.querySelector('[data-testid="connector-gap-pill"]')?.textContent).toContain('Connect');
    await render('connected');
    expect(host.querySelector('[data-testid="session-connector-gaps"]')).toBeNull();
    await render('expired');
    expect(host.querySelector('[data-testid="connector-gap-pill"]')?.textContent).toContain('Reconnect');
    // Removed from the space since: nothing left to connect.
    await render(null);
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

  it('prettifies a claude.ai global-setup tool too, in both the live line and the finished step list, with a "your setup" tooltip', async () => {
    const running: SessionEvent[] = [
      { seq: 1, kind: 'tool_call', payload: { toolCallId: 't1', title: 'mcp__claude_ai_Linear__list_issues', kind: 'fetch', status: 'in_progress' } },
    ];
    await act(async () => {
      root.render(<SessionCard meta={{ ...runMeta, status: 'running' }} events={running} owner={undefined} />);
    });
    const liveLine = host.querySelector<HTMLElement>('[data-testid="session-live-line"] .active-shimmer-muted')!;
    expect(liveLine.textContent).toContain('Linear · list issues');
    expect(liveLine.title).toBe('From your Claude setup');

    const done: SessionEvent[] = [...running.map((e) => ({ ...e, payload: { ...e.payload, status: 'completed' } })), { seq: 2, kind: 'turn_ended', payload: { status: 'done' } }];
    await act(async () => {
      root.render(<SessionCard meta={{ ...runMeta, status: 'done' }} events={done} owner={undefined} />);
    });
    await act(async () => click(host.querySelector('[data-testid="session-summary"]')!));
    const step = host.querySelector<HTMLElement>('[data-testid="session-step"] span')!;
    expect(step.textContent).toContain('Linear · list issues');
    expect(step.title).toBe('From your Claude setup');
  });

  it('names a claude.ai connector that is not in the catalog (Claude Docs) in the live line and its approval, without a logo', async () => {
    const running: SessionEvent[] = [
      { seq: 1, kind: 'tool_call', payload: { toolCallId: 't1', title: 'mcp__claude_ai_Claude_Docs__update', kind: 'other', status: 'pending' } },
    ];
    await act(async () => {
      root.render(<SessionCard meta={{ ...runMeta, status: 'running' }} events={running} owner={undefined} />);
    });
    expect(host.querySelector('[data-testid="session-live-line"]')?.textContent).toContain('Claude Docs · update');

    const asking: SessionEvent[] = [
      ...running,
      {
        seq: 2,
        kind: 'permission_requested',
        payload: {
          requestId: 'perm-1',
          toolCall: { toolCallId: 't1', title: 'mcp__claude_ai_Claude_Docs__update' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      },
    ];
    await act(async () => {
      root.render(
        <SessionCard meta={{ ...runMeta, status: 'running' }} events={asking} owner={undefined} onResolvePermission={vi.fn()} />
      );
    });
    expect(host.querySelector('[data-testid="approval-card"] code')?.textContent).toBe('Claude Docs · update');
  });

  it("reads rig's own tools as \"Rig · invite hugo@…\", once their input streams in, in the live line, the approval and the step list", async () => {
    const running: SessionEvent[] = [
      { seq: 1, kind: 'tool_call', payload: { toolCallId: 't1', title: 'mcp__rig__rig_invite', kind: 'other', status: 'pending', rawInput: {} } },
      { seq: 2, kind: 'tool_call_update', payload: { toolCallId: 't1', rawInput: { email: 'hugo@acme.co', role: 'editor' } } },
    ];
    await act(async () => {
      root.render(<SessionCard meta={{ ...runMeta, status: 'running' }} events={running} owner={undefined} />);
    });
    expect(host.querySelector('[data-testid="session-live-line"]')?.textContent).toContain('Rig · invite hugo@acme.co');

    const asking: SessionEvent[] = [
      ...running,
      {
        seq: 3,
        kind: 'permission_requested',
        payload: {
          requestId: 'perm-1',
          toolCall: { toolCallId: 't1', title: 'mcp__rig__rig_invite' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      },
    ];
    await act(async () => {
      root.render(
        <SessionCard meta={{ ...runMeta, status: 'running' }} events={asking} owner={undefined} onResolvePermission={vi.fn()} />
      );
    });
    expect(host.querySelector('[data-testid="approval-card"] code')?.textContent).toBe('Rig · invite hugo@acme.co');

    const done: SessionEvent[] = [
      ...running,
      { seq: 3, kind: 'tool_call_update', payload: { toolCallId: 't1', status: 'completed' } },
      { seq: 4, kind: 'turn_ended', payload: { status: 'done' } },
    ];
    await act(async () => {
      root.render(<SessionCard meta={{ ...runMeta, status: 'done' }} events={done} owner={undefined} />);
    });
    await act(async () => click(host.querySelector('[data-testid="session-summary"]')!));
    expect(host.querySelector('[data-testid="session-step"]')?.textContent).toContain('Rig · invite hugo@acme.co');
  });

  it("drops a turn's footer gap for a connector the run's own agent already reaches globally, but keeps it for a different agent", async () => {
    const globalSetup: GlobalServer[] = [
      { agent: 'claude', name: 'claude.ai Linear', url: 'https://mcp.linear.app/mcp', connectorId: 'linear' },
    ];
    await act(async () => {
      root.render(
        <SessionCard
          meta={runMeta}
          events={gapEvents}
          owner={undefined}
          viewerIsOwner
          onConnectorConnect={vi.fn()}
          globalSetup={globalSetup}
        />
      );
    });
    expect(host.querySelector('[data-testid="session-connector-gaps"]')).toBeNull();

    await act(async () => {
      root.render(
        <SessionCard
          meta={{ ...runMeta, agent: 'codex' }}
          events={gapEvents}
          owner={undefined}
          viewerIsOwner
          onConnectorConnect={vi.fn()}
          globalSetup={globalSetup}
        />
      );
    });
    expect(host.querySelector('[data-testid="session-connector-gaps"]')).not.toBeNull();
  });
});

