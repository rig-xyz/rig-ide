import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as MotionModule from 'motion/react';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type * as NotificationsModule from '@renderer/features/notifications/use-notifications';
import { RoomTranscript } from '@renderer/features/spaces/components/room-transcript';
import { RoomView } from '@renderer/features/spaces/components/room-view';
import { ThemeDock } from '@renderer/features/spaces/components/theme-dock';
import type * as RoomFeedModule from '@renderer/features/spaces/fixtures/room-feed';
import {
  applyThemeEvents,
  themesFromSnapshot,
  type RoomThemes,
} from '@renderer/features/spaces/themes';
import type { RoomMessage, RoomSnapshot, SessionEvent } from '@renderer/features/spaces/types';
import { requestRoomTheme } from '@renderer/features/spaces/room-theme-request';
import { useDockFocus } from '@renderer/features/spaces/use-dock-focus';
import { DOCK_TIMING } from '@renderer/features/spaces/use-dock-signals';
import { useForYou } from '@renderer/features/spaces/use-for-you';
import type { RigNotification } from '@shared/rig/notifications';
import '@renderer/tokens.css';

const mocks = vi.hoisted(() => ({
  resolvePermission: vi.fn(async (_input: unknown) => ({ resolved: true })),
  roomThemesEnabled: true,
  reducedMotion: false,
  activity: null as RigNotification[] | null,
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: (input: unknown) => mocks.toast(input) }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    rig: {
      spacesDispatch: { resolvePermission: (input: unknown) => mocks.resolvePermission(input) },
      settings: { get: async () => ({ roomThemesEnabled: mocks.roomThemesEnabled }) },
      notifications: {
        setViewing: async () => undefined,
        markSpaceRead: async () => ({ success: true, data: undefined }),
      },
      spacesConnection: {
        getConnectionInfo: async () => ({ success: false, error: { message: 'offline' } }),
      },
      attachments: { prepare: async () => ({ space: { status: 'ok' }, files: [] }) },
    },
  },
  events: { on: () => () => {} },
}));

vi.mock('@renderer/features/notifications/use-notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  useSpaceActivity: () => mocks.activity,
}));

vi.mock('@renderer/features/spaces/connectors-api', () => ({
  connectorsApi: {
    list: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue({ ok: true }),
    cancel: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    globalSetup: vi.fn().mockResolvedValue([]),
  },
}));

// The scripted demo, all in one beat: it is over at once.
vi.mock('@renderer/features/spaces/fixtures/room-feed', async (importOriginal) => {
  const original = await importOriginal<typeof RoomFeedModule>();
  return {
    ...original,
    buildRoomFeed: (options?: { dock?: boolean }) => {
      const script = original.buildRoomFeed(options);
      return {
        ...script,
        beats: [{ delayMs: 0, events: script.beats.flatMap((beat) => beat.events) }],
      };
    },
  };
});

vi.mock('motion/react', async (importOriginal) => {
  const original = await importOriginal<typeof MotionModule>();
  return { ...original, useReducedMotion: () => mocks.reducedMotion };
});

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const hover = (el: Element) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
const press = (key: string) =>
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );
const pointerDownOutside = () =>
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
const sleep = (ms: number) =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
/** Waits for something that settles after an exit animation. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 40 });

// ────────── fixtures ──────────

const SELF = 'me';

function msg(id: string, seq: number, extra: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id,
    seq,
    authorId: seq % 2 ? 'sam' : 'maya',
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, seq)).toISOString(),
    time: `10:0${seq}`,
    body: `body of ${id}`,
    meta: { kind: 'text' },
    ...extra,
  };
}

const permissionEvents = (
  requestId: string,
  seq: number,
  title = `run ${requestId}`
): SessionEvent[] => [
  {
    seq,
    kind: 'tool_call',
    payload: { toolCallId: `t-${requestId}`, title, kind: 'execute', status: 'pending' },
  },
  {
    seq: seq + 1,
    kind: 'permission_requested',
    payload: {
      requestId,
      toolCall: { toolCallId: `t-${requestId}`, title },
      options: [
        { optionId: `reject-${requestId}`, name: 'No', kind: 'reject_once' },
        { optionId: `always-${requestId}`, name: 'Always', kind: 'allow_always' },
        { optionId: `allow-${requestId}`, name: 'Yes', kind: 'allow_once' },
      ],
    },
  },
];

const theme = (id: string, count: number, lastSeq: number, name = `Theme ${id}`) => ({
  id,
  name,
  description: `About ${id}`,
  bornSeq: 1,
  count,
  lastSeq,
});

function themesOf(
  list: ReturnType<typeof theme>[],
  assignments: Record<string, string>,
  cursor = '10'
): RoomThemes {
  return {
    enabled: true,
    list,
    themeOf: Object.fromEntries(
      Object.entries(assignments).map(([id, themeId]) => [id, { themeId, via: 'jev' as const }])
    ),
    cursor,
  };
}

/** Six messages in three themes, a run of yours waiting on two approvals, and your Claude. */
function room(extra: Partial<RoomSnapshot> = {}): RoomSnapshot {
  const messages = [
    msg('m1', 1),
    msg('m2', 2),
    msg('m3', 3),
    msg('m4', 4),
    msg('m5', 5),
    msg('s1', 6, { authorId: SELF, meta: { kind: 'session', runId: 'r1' } }),
  ];
  return {
    name: 'launch',
    ready: true,
    members: [
      { id: SELF, name: 'Dylan', email: 'd@x.co', role: 'owner', initial: 'D', status: 'here' },
      { id: 'sam', name: 'Sam', email: 's@x.co', role: 'editor', initial: 'S', status: 'here' },
      { id: 'maya', name: 'Maya', email: 'm@x.co', role: 'editor', initial: 'M', status: 'here' },
      {
        id: 'away',
        name: 'Ola',
        email: 'o@x.co',
        role: 'editor',
        initial: 'O',
        status: 'here',
        online: false,
      },
      {
        id: 'inv',
        name: 'Invitee',
        email: 'i@x.co',
        role: 'editor',
        initial: 'I',
        status: 'invited',
      },
    ],
    agents: [{ agent: 'claude', owner: SELF, model: 'opus', busy: false }],
    connectors: [],
    skills: [],
    messages,
    invitesById: {},
    sessionMetaByRun: {
      r1: {
        id: 'r1',
        agent: 'claude',
        owner: SELF,
        model: 'opus',
        title: 'r1',
        status: 'running',
        startedAt: '2026-10-01T10:00:00Z',
        endedAt: null,
      },
    },
    sessionEventsByRun: {
      r1: [
        ...permissionEvents('p1', 1, 'Read the numbers'),
        ...permissionEvents('p2', 3, 'Write the review'),
      ],
    },
    typingUserIds: [],
    themes: themesOf(
      [
        theme('launch', 3, 5, 'Launch'),
        theme('pricing', 2, 3, 'Pricing'),
        theme('lunch', 1, 1, 'Lunch'),
      ],
      { m1: 'lunch', m2: 'pricing', m3: 'pricing', m4: 'launch', m5: 'launch', s1: 'launch' }
    ),
    ...extra,
  };
}

const ask = (id: string, messageId: string, who = 'maya', name = 'Maya'): RigNotification => ({
  id,
  type: 'mention',
  tier: 'direct',
  bindingId: 'b1',
  spaceName: 'Launch',
  actor: { kind: 'user', userId: who, name, agent: null },
  messageId,
  messageSeq: null,
  runId: null,
  requestId: null,
  inviteId: null,
  path: null,
  title: '',
  body: 'hey',
  createdAt: '2026-10-01T10:00:00Z',
  readAt: null,
});

// ────────── harness: the Room's own wiring, without its relay ──────────

/** The Room after a live `born` and an `assign`, the way the source applies them. */
const withBirth = (snapshot: RoomSnapshot, themeId = 'fresh', name = 'Fresh'): RoomSnapshot => ({
  ...snapshot,
  themes: applyThemeEvents(
    snapshot.themes!,
    [
      { id: '11', atSeq: 7, type: 'born', themeId, name, description: '', bornSeq: 7 },
      { id: '12', atSeq: 7, type: 'assign', messageId: 'm5', themeId, via: 'jev' },
    ],
    '12',
    (id) => snapshot.messages.find((m) => m.id === id)?.seq
  ),
});

/** The pinned panel's content, as the Room gives it to the dock: 304 wide, with its own header and body. */
function CardBody() {
  return (
    <div
      data-testid="card-body"
      style={{ width: 304, height: 260, padding: 8, boxSizing: 'border-box' }}
    >
      Space settings
    </div>
  );
}

function Harness({
  snapshot,
  onExpand,
  narrow,
  withCard,
}: {
  snapshot: RoomSnapshot;
  onExpand?: (section?: 'people') => void;
  narrow?: boolean;
  /** The Room's wiring: the dock owns the panel, which opens on the chevron and folds on the same one. */
  withCard?: boolean;
}) {
  const [cardOpen, setCardOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<ReadonlySet<string> | null>(null);
  const forYouState = useForYou('b1', snapshot, SELF);
  const focus = useDockFocus({
    enabled: true,
    themes: snapshot.themes,
    forYou: forYouState.forYou,
    dismiss: forYouState.dismiss,
  });
  return (
    <div className="relative flex flex-col" style={{ height: 640, width: 900 }}>
      <RoomTranscript
        snapshot={snapshot}
        ownId={SELF}
        focus={focus.transcriptFocus}
        previewIds={preview}
      />
      <ThemeDock
        snapshot={snapshot}
        selfUserId={SELF}
        forYouState={forYouState}
        focus={focus}
        narrow={narrow}
        onExpand={
          withCard
            ? (section) => {
                setCardOpen(true);
                onExpand?.(section);
              }
            : onExpand
        }
        card={
          withCard
            ? { open: cardOpen, content: <CardBody />, onFold: () => setCardOpen(false) }
            : undefined
        }
        onPreviewChange={setPreview}
        className="absolute top-3 right-4"
      />
    </div>
  );
}

const DEFAULT_TIMING = { ...DOCK_TIMING };

describe('Room dock', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The dock's clocks, fast: a birth is over in 0.4s, a swell in 0.3s.
    Object.assign(DOCK_TIMING, {
      hearingMs: 200,
      dropAfterMs: 40,
      slideAfterMs: 200,
      settleAfterMs: 400,
      newTagMs: 500,
      swellMs: 300,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.activity = [];
    mocks.reducedMotion = false;
    mocks.roomThemesEnabled = true;
    mocks.resolvePermission.mockReset();
    mocks.resolvePermission.mockImplementation(async () => ({ resolved: true }));
    mocks.toast.mockClear();
    localStorage.clear();
  });
  afterEach(async () => {
    Object.assign(DOCK_TIMING, DEFAULT_TIMING);
    await act(async () => root.unmount());
    host.remove();
  });

  const show = async (
    snapshot: RoomSnapshot,
    onExpand?: (section?: 'people') => void,
    narrow?: boolean,
    withCard?: boolean
  ) => {
    await act(async () =>
      root.render(
        <Harness snapshot={snapshot} onExpand={onExpand} narrow={narrow} withCard={withCard} />
      )
    );
    await sleep(60);
  };
  const q = <T extends Element = HTMLElement>(testId: string) =>
    host.querySelector<T>(`[data-testid="${testId}"]`);
  const all = (testId: string) => [
    ...host.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
  ];
  const rows = () =>
    [
      ...host.querySelectorAll<HTMLElement>(
        '[data-message-id], [data-testid="transcript-fold"], [data-testid="transcript-fold-back"]'
      ),
    ].map(
      (el) =>
        el.dataset.messageId ?? (el.dataset.testid === 'transcript-fold' ? 'fold' : 'fold-back')
    );
  const pillNames = () => all('dock-pill').map((p) => p.dataset.themeId);
  /** A thing the stage placed: a pill, the rail, a float. */
  const item = (id: string) => host.querySelector<HTMLElement>(`[data-dock-item="${id}"]`);
  /** Its goo shape, in the one filtered layer. */
  const shape = (id: string) => host.querySelector<HTMLElement>(`[data-shape="${id}"]`);
  const shapes = () =>
    [...host.querySelectorAll<HTMLElement>('[data-testid="dock-goo"] [data-shape]')].map(
      (el) => el.dataset.shape
    );
  /** How far an item's left edge is from the dock's right edge: the same number is the same left edge on screen. */
  const edge = (id: string) => Number(item(id)!.dataset.edge);
  const width = (id: string) => Number(item(id)!.dataset.width);
  /** Where the pills' shared left edge is: the rail's, or the column's 208px when the rail is narrower. */
  const columnEdge = () => Math.max(edge('rail'), 208);
  const unhover = (el: Element) =>
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  const dimmedRows = () =>
    [...host.querySelectorAll<HTMLElement>('[data-message-id]')]
      .filter((row) => row.dataset.previewDimmed === 'true')
      .map((row) => row.dataset.messageId);

  describe('the rail', () => {
    it('shows who is in the Space, agents as square tiles with the owner on the corner, and one chevron that opens the panel', async () => {
      const onExpand = vi.fn();
      await show(room(), onExpand);
      // Everyone but the invited one: you and the online members, then the member away.
      expect(all('dock-member')).toHaveLength(4);
      const agents = all('dock-agent');
      expect(agents).toHaveLength(1);
      expect(agents[0]!.dataset.own).toBe('true');
      // Agent first, as everywhere else: the agent's mark is the tile, its owner the badge on it.
      expect(agents[0]!.textContent).toContain('D');
      expect(
        agents[0]!.querySelector('[data-testid="agent-avatar"]')?.getAttribute('data-agent')
      ).toBe('claude');
      const toggle = q('dock-toggle')!;
      expect(toggle.getAttribute('aria-label')).toBe('Open Space details');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(q('dock-toggle-icon')!.style.transform).toBe('rotate(0deg)');
      // One control, drawn by the stage in the rail's top-right corner.
      expect(q('dock-corner')!.style.right).toBe('6px');
      expect(q('dock-corner')!.style.top).toBe('6px');
      expect(host.querySelectorAll('[data-testid="dock-toggle"]')).toHaveLength(1);
      await act(async () => click(toggle));
      expect(onExpand).toHaveBeenCalledOnce();
      expect(onExpand.mock.calls[0]).toEqual([undefined]);
    });

    it('keeps the rail at its natural width and makes the pill column at least 208px, so a lone member does not squeeze the names', async () => {
      const alone = room({
        themes: themesOf(
          [theme('investor', 3, 5, 'Investor update'), theme('pricing', 2, 3, 'Pricing review')],
          { m1: 'investor', m2: 'investor', m3: 'investor', m4: 'pricing', m5: 'pricing' }
        ),
        members: [room().members[0]!],
        sessionMetaByRun: {},
        sessionEventsByRun: {},
        typingUserIds: [],
      });
      await show(alone, vi.fn());
      expect(all('dock-member')).toHaveLength(1);
      // The rail hugs what it holds: no minimum width, no stretching.
      expect(q('dock-rail')!.style.minWidth).toBe('');
      expect(width('rail')).toBeLessThan(208);
      expect(edge('rail')).toBe(width('rail'));
      expect(item('rail')!.style.right).toBe('0px');
      // Every pill shares the column's left edge, 208px from the dock's right edge, and fits the column.
      expect(all('dock-pill')).toHaveLength(2);
      for (const pill of all('dock-pill')) {
        const id = pill.closest<HTMLElement>('[data-dock-item]')!.dataset.dockItem!;
        expect(edge(id)).toBe(208);
        expect(width(id)).toBeLessThanOrEqual(208);
        // A name that did not fit a tiny rail has room now: nothing truncates inside the column.
        const label = pill.querySelector<HTMLElement>('.truncate')!;
        expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
      }
      expect(q('dock-toggle')).not.toBeNull();
    });

    it('shows six people at most, then a "+N" that opens the panel at People', async () => {
      const people = Array.from({ length: 9 }, (_, i) => ({
        id: `p${i}`,
        name: `Person ${i}`,
        email: '',
        role: 'editor',
        initial: 'P',
        status: 'here' as const,
      }));
      const onExpand = vi.fn();
      await show(room({ members: [room().members[0]!, ...people] }), onExpand);
      expect(all('dock-member')).toHaveLength(6);
      const more = q('dock-members-more')!;
      expect(more.textContent).toBe('+4');
      expect(more.getAttribute('aria-label')).toBe('4 more people');
      await act(async () => click(more));
      expect(onExpand).toHaveBeenCalledWith('people');
      // Exactly six: no chip.
      await show(room({ members: [room().members[0]!, ...people.slice(0, 5)] }), onExpand);
      expect(all('dock-member')).toHaveLength(6);
      expect(q('dock-members-more')).toBeNull();
    });

    it('shows three agents at most, then a "+N" that opens the panel', async () => {
      const run = (id: string, owner: string, agent: 'claude' | 'codex', at: string) => ({
        id,
        agent,
        owner,
        model: 'x',
        title: id,
        status: 'done' as const,
        startedAt: at,
        endedAt: at,
      });
      const onExpand = vi.fn();
      await show(
        room({
          sessionMetaByRun: {
            a: run('a', SELF, 'claude', '2026-10-01T10:00:00Z'),
            b: run('b', SELF, 'codex', '2026-10-01T09:00:00Z'),
            c: run('c', 'sam', 'claude', '2026-10-01T08:00:00Z'),
            d: run('d', 'maya', 'codex', '2026-09-01T08:00:00Z'),
            e: run('e', 'maya', 'claude', '2026-09-01T07:00:00Z'),
          },
          sessionEventsByRun: {},
        }),
        onExpand
      );
      expect(all('dock-agent')).toHaveLength(3);
      const more = q('dock-agents-more')!;
      expect(more.textContent).toBe('+2');
      expect(more.getAttribute('aria-label')).toBe('2 more agents');
      await act(async () => click(more));
      expect(onExpand).toHaveBeenCalledOnce();
    });

    it('greys the people who are away and puts them after the present ones, typing first', async () => {
      const members = [
        { id: SELF, name: 'Dylan', email: '', role: 'owner', initial: 'D', status: 'here' as const },
        { id: 'zoe', name: 'Zoe', email: '', role: 'editor', initial: 'Z', status: 'here' as const },
        {
          id: 'ana',
          name: 'Ana',
          email: '',
          role: 'editor',
          initial: 'A',
          status: 'here' as const,
          online: false,
        },
        { id: 'bea', name: 'Bea', email: '', role: 'editor', initial: 'B', status: 'here' as const },
        {
          id: 'cal',
          name: 'Cal',
          email: '',
          role: 'editor',
          initial: 'C',
          status: 'here' as const,
          online: false,
        },
        { id: 'inv', name: 'Invitee', email: '', role: 'editor', initial: 'I', status: 'invited' as const },
      ];
      await show(room({ members, typingUserIds: ['zoe'] }));
      const rail = all('dock-member');
      expect(rail.map((m) => m.getAttribute('aria-label'))).toEqual([
        'Zoe, typing',
        'Bea',
        'Dylan',
        'Ana, away',
        'Cal, away',
      ]);
      expect(rail.map((m) => m.dataset.presence)).toEqual(['here', 'here', 'here', 'away', 'away']);
      // Greyed: dimmer and desaturated, still there.
      const greyed = (el: HTMLElement) => /\bopacity-45\b/.test(el.firstElementChild!.className) && /\bgrayscale\b/.test(el.firstElementChild!.className);
      expect(rail.map(greyed)).toEqual([false, false, false, true, true]);
      // Halos still ring the typist.
      expect(all('dock-halo')).toHaveLength(1);
      expect(rail[0]!.querySelector('[data-testid="dock-halo"]')).not.toBeNull();
    });

    it('moves someone to the present ones when they come back, and orders by name within a group', async () => {
      const base = room().members;
      const away = (id: string) =>
        base.map((m) => (m.id === id ? { ...m, online: false } : m)).filter((m) => m.id !== 'inv');
      await show(room({ members: away('sam') }));
      const names = () => all('dock-member').map((m) => m.getAttribute('aria-label'));
      expect(names()).toEqual(['Dylan', 'Maya', 'Ola, away', 'Sam, away']);
      await show(room({ members: base.filter((m) => m.id !== 'inv') }));
      expect(names()).toEqual(['Dylan', 'Maya', 'Sam', 'Ola, away']);
    });

    it('puts the agents that are working first and greys the idle ones', async () => {
      const run = (
        id: string,
        owner: string,
        agent: 'claude' | 'codex',
        status: 'running' | 'done',
        at: string
      ) => ({
        id,
        agent,
        owner,
        model: 'x',
        title: id,
        status,
        startedAt: at,
        endedAt: status === 'done' ? at : null,
      });
      const ended: SessionEvent[] = [{ seq: 1, kind: 'turn_ended', payload: { status: 'done' } }];
      await show(
        room({
          sessionMetaByRun: {
            mine: run('mine', SELF, 'claude', 'done', '2026-10-01T10:00:00Z'),
            sams: run('sams', 'sam', 'codex', 'running', '2026-10-01T09:00:00Z'),
          },
          sessionEventsByRun: { mine: ended },
        })
      );
      const agents = all('dock-agent');
      // Sam's Codex is running, so it leads yours, which is idle.
      expect(agents.map((a) => `${a.dataset.agent}:${a.dataset.state}`)).toEqual([
        'codex:active',
        'claude:idle',
      ]);
      const greyed = (el: HTMLElement) => /\bopacity-45\b/.test(el.firstElementChild!.className) && /\bgrayscale\b/.test(el.firstElementChild!.className);
      expect(agents.map(greyed)).toEqual([false, true]);
    });

    it('spaces its avatars out at full size instead of overlapping them, with a separator before the agents', async () => {
      await show(room());
      const members = q('dock-members')!;
      expect(members.className).toContain('gap-[5px]');
      for (const member of all('dock-member')) {
        expect(member.className).not.toMatch(/-ml-|-mr-/);
        expect(member.querySelector('.size-7')).not.toBeNull();
      }
      expect(q('dock-agents')!.className).toContain('gap-[5px]');
      expect(q('dock-agents')!.previousElementSibling!.className).toContain('w-px');
    });

    it("shows every agent that ran here, yours first, and no more than three agents", async () => {
      const run = (id: string, owner: string, agent: 'claude' | 'codex', startedAt: string) => ({
        id,
        agent,
        owner,
        model: 'x',
        title: id,
        status: 'done' as const,
        startedAt,
        endedAt: startedAt,
      });
      const snapshot = room({
        sessionMetaByRun: {
          mine: run('mine', SELF, 'claude', '2026-10-01T10:00:00Z'),
          sams: run('sams', 'sam', 'codex', '2026-10-01T09:00:00Z'),
          mayas: run('mayas', 'maya', 'claude', '2026-10-01T08:00:00Z'),
          old: run('old', 'away', 'claude', '2026-09-20T08:00:00Z'),
        },
        sessionEventsByRun: {},
      });
      await show(snapshot);
      const agents = all('dock-agent').map((a) => `${a.dataset.agent}:${a.dataset.own}`);
      expect(agents).toEqual(['claude:true', 'codex:false', 'claude:false']);
      // The one that ran long ago is still an agent of the Space: behind "+1".
      expect(q('dock-agents-more')!.textContent).toBe('+1');
    });

    it("listens with the app's dot matrix, not bars: breathing at rest, searching while theme events arrive, rippling at a birth", async () => {
      await show(room());
      const listener = q('dock-listener')!;
      const matrix = () => listener.querySelector<HTMLElement>('[data-state]');
      expect(listener.dataset.hearing).toBe('false');
      expect(matrix()!.dataset.state).toBe('waiting');
      expect(matrix()!.getAttribute('aria-label')).toBe('Listening for themes');
      // One matrix, and no bars or bead beside it.
      expect(listener.querySelectorAll('[data-state]')).toHaveLength(1);
      // The medium one (4px dots, about an avatar's weight), not the large.
      expect(matrix()!.firstElementChild!.className).toContain('size-1');
      expect(matrix()!.firstElementChild!.className).not.toContain('size-2');
      expect(q('dock-bead')).toBeNull();
      await show(room({ themes: { ...room().themes!, cursor: '11' } }));
      expect(listener.dataset.hearing).toBe('true');
      expect(matrix()!.dataset.state).toBe('searching');
      await until(() => expect(matrix()!.dataset.state).toBe('waiting'));
      await show(withBirth(room()));
      expect(matrix()!.dataset.state).toBe('starting');
      await until(() => expect(matrix()!.dataset.state).toBe('waiting'));
    });

    describe('halos: about to post', () => {
      const halos = () => all('dock-halo');
      const haloOf = (el: HTMLElement) => el.querySelector('[data-testid="dock-halo"]');
      const member = (name: string) =>
        all('dock-member').find((m) => m.getAttribute('aria-label')?.startsWith(name))!;
      /** Your Claude and Sam's Codex, their latest turns running with nothing to approve. */
      const working = (extra: Partial<RoomSnapshot> = {}) => {
        const run = (id: string, owner: string, agent: 'claude' | 'codex') => ({
          id,
          agent,
          owner,
          model: 'x',
          title: id,
          status: 'running' as const,
          startedAt: '2026-10-01T10:00:00Z',
          endedAt: null,
        });
        return room({
          sessionMetaByRun: { mine: run('mine', SELF, 'claude'), sams: run('sams', 'sam', 'codex') },
          sessionEventsByRun: {},
          ...extra,
        });
      };
      const agent = (kind: string, own: string) =>
        all('dock-agent').find((a) => a.dataset.agent === kind && a.dataset.own === own)!;

      it('rings a member while they type, and takes it off when they stop', async () => {
        await show(room({ typingUserIds: ['sam'] }));
        expect(halos()).toHaveLength(1);
        expect(haloOf(member('Sam'))).not.toBeNull();
        expect(haloOf(member('Maya'))).toBeNull();
        // Two at once are fine.
        await show(room({ typingUserIds: ['sam', 'maya'] }));
        expect(halos()).toHaveLength(2);
        await show(room({ typingUserIds: ['maya'] }));
        expect(halos()).toHaveLength(1);
        expect(haloOf(member('Maya'))).not.toBeNull();
        await show(room({ typingUserIds: [] }));
        expect(halos()).toHaveLength(0);
      });

      it('rings an agent while its turn works, not while it waits on an approval or after it ends', async () => {
        await show(working());
        expect(halos()).toHaveLength(2);
        expect(haloOf(agent('claude', 'true'))).not.toBeNull();
        expect(haloOf(agent('codex', 'false'))).not.toBeNull();
        // Your Claude stops to ask: waiting is not working.
        await show(
          working({
            sessionEventsByRun: { mine: permissionEvents('p1', 1) },
          })
        );
        expect(haloOf(agent('claude', 'true'))).toBeNull();
        expect(haloOf(agent('codex', 'false'))).not.toBeNull();
        // Sam's turn ends.
        await show(
          working({
            sessionEventsByRun: {
              mine: permissionEvents('p1', 1),
              sams: [{ seq: 1, kind: 'turn_ended', payload: { status: 'done' } }],
            },
          })
        );
        expect(halos()).toHaveLength(0);
        // The default room: your run is waiting on two approvals, so no halo.
        await show(room());
        expect(halos()).toHaveLength(0);
      });

      it('names the state in the accessible name, with no live region', async () => {
        await show(working({ typingUserIds: ['sam'] }));
        expect(member('Sam').getAttribute('aria-label')).toBe('Sam, typing');
        expect(member('Maya').getAttribute('aria-label')).toBe('Maya');
        expect(agent('claude', 'true').getAttribute('aria-label')).toBe('Your Claude, working');
        expect(agent('codex', 'false').getAttribute('aria-label')).toBe("Sam's Codex working");
        expect(halos().every((h) => h.getAttribute('aria-hidden') === 'true')).toBe(true);
        expect(host.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
        await show(room());
        expect(member('Sam').getAttribute('aria-label')).toBe('Sam');
        expect(agent('claude', 'true').getAttribute('aria-label')).toBe(
          'Your Claude, 2 approvals waiting'
        );
      });

      it('sits on the content layer, not in the goo', async () => {
        await show(working({ typingUserIds: ['sam'] }));
        expect(halos().length).toBeGreaterThan(0);
        expect(q('dock-goo')!.querySelector('[data-testid="dock-halo"]')).toBeNull();
        expect(q('dock-rail')!.contains(halos()[0]!)).toBe(true);
      });

      it('breathes slowly in the accent colour, and holds still under reduced motion', async () => {
        await show(room({ typingUserIds: ['sam'] }));
        const ring = () => halos()[0]!.querySelector<HTMLElement>('.dock-halo-ring')!;
        expect(halos()[0]!.dataset.motion).toBe('on');
        expect(getComputedStyle(ring()).animationName).toBe('dock-halo-breathe');
        expect(getComputedStyle(ring()).animationDuration).toBe('2s');
        expect(getComputedStyle(ring()).animationIterationCount).toBe('infinite');
        expect(getComputedStyle(ring()).boxShadow).not.toBe('none');
        mocks.reducedMotion = true;
        await show(room({ typingUserIds: ['maya'] }));
        expect(halos()[0]!.dataset.motion).toBe('off');
        expect(getComputedStyle(ring()).animationName).toBe('none');
        expect(getComputedStyle(halos()[0]!).animationName).toBe('none');
        // Still a ring.
        expect(getComputedStyle(ring()).boxShadow).not.toBe('none');
      });

      it('changes neither the avatars nor the rail', async () => {
        // Someone who types moves to the front of the rail, so compare the rail itself and the sizes taken, not who is where.
        const box = (el: Element) => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return [x, y, width, height].map((n) => Math.round(n * 100) / 100);
        };
        const boxes = () => ({
          rail: box(q('dock-rail')!),
          sizes: [...all('dock-member'), ...all('dock-agent')]
            .map((el) => box(el).slice(2).join('x'))
            .sort(),
          count: all('dock-member').length + all('dock-agent').length,
        });
        const ended: SessionEvent[] = [{ seq: 1, kind: 'turn_ended', payload: { status: 'done' } }];
        await show(working({ sessionEventsByRun: { mine: ended, sams: ended } }));
        expect(halos()).toHaveLength(0);
        const quiet = boxes();
        await show(working({ typingUserIds: ['sam', 'maya'] }));
        expect(halos()).toHaveLength(4);
        expect(boxes()).toEqual(quiet);
      });
    });
  });

  describe('the pills', () => {
    it('lists themes most recently active first, with counts', async () => {
      await show(room());
      expect(pillNames()).toEqual(['launch', 'pricing', 'lunch']);
      expect(all('dock-pill').map((p) => p.textContent)).toEqual(['Launch3', 'Pricing2', 'Lunch1']);
    });

    it('leads with For you when something waits on you, counting asks and approval runs', async () => {
      mocks.activity = [ask('n1', 'm2'), ask('n2', 'm5', 'sam', 'Sam')];
      await show(room());
      const pills = [...q('dock-pills')!.querySelectorAll('button')];
      expect(pills[0]!.dataset.testid).toBe('dock-pill-for-you');
      // Two asks and one run waiting on approval.
      expect(pills[0]!.textContent).toBe('For you3');
    });

    it('has no For you pill when nothing waits on you', async () => {
      await show(room({ sessionEventsByRun: {} }));
      expect(q('dock-pill-for-you')).toBeNull();
    });

    it('marks the themes that hold something waiting on you, a comment reply under its thread root', async () => {
      const comment = (id: string, seq: number, isReply: boolean) =>
        msg(id, seq, {
          threadId: 'c1',
          meta: {
            kind: 'comment_mirror',
            commentId: 'c1',
            path: 'a.md',
            quote: 'q',
            ...(isReply ? { isReply: true } : {}),
          },
        });
      const snapshot = room({
        messages: [msg('m1', 1), comment('c-root', 2, false), comment('c-reply', 3, true)],
        sessionEventsByRun: {},
        themes: themesOf([theme('launch', 1, 1), theme('pricing', 1, 2)], {
          m1: 'launch',
          'c-root': 'pricing',
        }),
      });
      mocks.activity = [{ ...ask('n1', 'c-reply'), type: 'reply' }];
      await show(snapshot);
      const waiting = all('dock-pill').filter((p) =>
        p.querySelector('[data-testid="dock-pill-waiting"]')
      );
      expect(waiting.map((p) => p.dataset.themeId)).toEqual(['pricing']);
    });

    it('shows six pills and keeps the rest behind +N, which focuses one on a click', async () => {
      const list = Array.from({ length: 8 }, (_, i) => theme(`t${i}`, 1, 10 + i, `Topic ${i}`));
      const assignments = Object.fromEntries(list.map((t, i) => [`x${i}`, t.id]));
      const messages = list.map((_, i) => msg(`x${i}`, 10 + i));
      await show(
        room({
          messages,
          sessionEventsByRun: {},
          sessionMetaByRun: {},
          themes: themesOf(list, assignments),
        })
      );
      expect(pillNames()).toEqual(['t7', 't6', 't5', 't4', 't3', 't2']);
      const more = q('dock-more')!;
      expect(more.textContent).toBe('+2');
      await act(async () => click(more));
      await sleep(60);
      expect(all('dock-more-item').map((i) => i.dataset.themeId)).toEqual(['t1', 't0']);
      await act(async () => click(all('dock-more-item')[0]!));
      await sleep(100);
      // The picked theme is a card now, and keeps its place among the pills.
      expect(q('dock-focus-card')?.textContent).toContain('Topic 1');
      expect(rows().filter((r) => r.startsWith('x'))).toEqual(['x1']);
    });

    it('leaves out a theme with nothing in it, and one that has been quiet for 60 messages', async () => {
      const quietMessages = Array.from({ length: 70 }, (_, i) => msg(`q${i}`, i + 1));
      const snapshot = room({
        messages: quietMessages,
        sessionEventsByRun: {},
        sessionMetaByRun: {},
        themes: themesOf([theme('busy', 5, 70), theme('quiet', 5, 3), theme('empty', 0, 70)], {
          q69: 'busy',
          q2: 'quiet',
        }),
      });
      await show(snapshot);
      expect(pillNames()).toEqual(['busy']);
      // The quiet one is still reachable.
      expect(q('dock-more')!.textContent).toBe('+1');
    });

    it('tags a theme born while the Room is open as new, and not the ones it opened with', async () => {
      await show(room());
      expect(all('dock-pill-new')).toHaveLength(0);
      await show(withBirth(room()));
      const fresh = all('dock-pill').find((p) => p.dataset.themeId === 'fresh')!;
      expect(fresh.querySelector('[data-testid="dock-pill-new"]')).not.toBeNull();
      expect(all('dock-pill-new')).toHaveLength(1);
      // The tag is the whole announcement: the listener has no notice.
      expect(q('dock-notice')).toBeNull();
    });

    it('does not tag or drop in a theme that only arrives with a snapshot (a re-sync, a first load)', async () => {
      await show(room());
      const base = room();
      // The relay's snapshot after a reconnect: a theme the Room had not heard of, and no events applied.
      const resynced = themesFromSnapshot({
        enabled: true,
        themes: [...base.themes!.list, theme('fresh', 1, 7, 'Fresh')],
        assignments: { ...base.themes!.themeOf, m5: { themeId: 'fresh', via: 'jev' } },
        latestEventId: '20',
      });
      await show(room({ themes: resynced }));
      expect(pillNames()).toContain('fresh');
      expect(all('dock-pill-new')).toHaveLength(0);
      expect(item('theme:fresh')!.dataset.phase).toBe('placed');
    });

    it('peeks a hovered pill with its description, count and last activity', async () => {
      await show(room());
      await act(async () => hover(all('dock-pill')[0]!));
      await sleep(60);
      const peek = q('dock-peek')!;
      expect(peek.textContent).toContain('Launch');
      expect(peek.textContent).toContain('About launch');
      expect(peek.textContent).toContain('3 messages.');
      expect(peek.textContent).toContain('Last from Your Claude at 10:06');
      expect(peek.textContent).toContain('Click to focus.');
    });
  });

  describe('focus', () => {
    it('filters the transcript to a theme with a fold for the rest, and the × clears it', async () => {
      await show(room());
      expect(rows()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 's1']);
      await act(async () => click(all('dock-pill').find((p) => p.dataset.themeId === 'pricing')!));
      await sleep(100);
      expect(rows()).toEqual(['fold', 'm2', 'm3', 'fold']);
      expect(all('transcript-fold').map((f) => f.textContent)).toEqual([
        '1 message in other themes',
        '3 messages in other themes',
      ]);
      const card = q('dock-focus-card')!;
      expect(card.textContent).toContain('Pricing');
      expect(card.textContent).toContain('About pricing');
      await act(async () => click(q('dock-focus-clear')!));
      await sleep(100);
      expect(rows()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 's1']);
      expect(q('dock-focus-card')).toBeNull();
    });

    it('clears on Esc, and when the same pill is clicked again', async () => {
      await show(room());
      const pricing = () => all('dock-pill').find((p) => p.dataset.themeId === 'pricing')!;
      await act(async () => click(pricing()));
      await sleep(100);
      expect(q('dock-focus-card')).not.toBeNull();
      await act(async () => void press('Escape'));
      await sleep(100);
      expect(q('dock-focus-card')).toBeNull();
      expect(rows()).toHaveLength(6);

      await act(async () => click(pricing()));
      await sleep(100);
      // Another pill moves the focus rather than clearing it.
      await act(async () => click(all('dock-pill').find((p) => p.dataset.themeId === 'launch')!));
      await sleep(100);
      expect(q('dock-focus-card')?.textContent).toContain('Launch');
      expect(rows()).toEqual(['fold', 'm4', 'm5', 's1']);
    });

    it('clears a focus on a theme that is merged away', async () => {
      await show(room());
      await act(async () => click(all('dock-pill').find((p) => p.dataset.themeId === 'lunch')!));
      await sleep(100);
      expect(q('dock-focus-card')).not.toBeNull();
      const base = room();
      await show(
        room({
          themes: {
            ...base.themes!,
            list: base.themes!.list.filter((t) => t.id !== 'lunch'),
            themeOf: { ...base.themes!.themeOf, m1: { themeId: 'pricing', via: 'gardener' } },
          },
        })
      );
      await until(() => expect(q('dock-focus-card')).toBeNull());
      expect(rows()).toHaveLength(6);
    });

    it('focuses For you with asks first and a line built from the model, and "Done" hides an ask', async () => {
      mocks.activity = [ask('n1', 'm2'), ask('n2', 'm5', 'sam', 'Sam')];
      await show(room());
      await act(async () => click(q('dock-pill-for-you')!));
      await sleep(100);
      expect(q('dock-focus-card')!.textContent).toContain(
        'Maya and Sam asked you directly. Your Claude has 2 approvals waiting.'
      );
      expect(rows()).toEqual(['m2', 'm5', 's1', 'fold']);
      expect(all('transcript-fold')[0]!.textContent).toBe('3 messages not waiting on you');
      expect(all('ask-done')).toHaveLength(2);
      await act(async () => click(all('ask-done')[0]!));
      await sleep(100);
      expect(rows()).toEqual(['m5', 's1', 'fold']);
      expect(JSON.parse(localStorage.getItem('rig-for-you-dismissed:b1')!)).toEqual(['n1']);
      expect(q('dock-focus-card')!.textContent).toContain('Sam asked you directly.');
    });

    it('lets your own reply clear an ask at once', async () => {
      mocks.activity = [ask('n1', 'm2')];
      const base = room({ sessionEventsByRun: {} });
      await show(base);
      expect(q('dock-pill-for-you')!.textContent).toBe('For you1');
      const reply = msg('mine', 7, {
        authorId: SELF,
        meta: { kind: 'text', replyTo: { id: 'm2', authorId: 'maya', excerpt: 'x' } as never },
      });
      await show({ ...base, messages: [...base.messages, reply] });
      await until(() => expect(q('dock-pill-for-you')).toBeNull());
    });
  });

  describe('approvals on your agent', () => {
    const badge = () => q('dock-approvals-badge');
    const openPanel = async () => {
      await act(async () => click(q('dock-agent')!));
      await sleep(80);
    };

    it('badges your agent with the pending requests, and says so when there are none', async () => {
      await show(room());
      expect(badge()!.textContent).toBe('2');
      await show(room({ sessionEventsByRun: {} }));
      await until(() => expect(badge()).toBeNull());
      await openPanel();
      expect(q('dock-approvals-empty')!.textContent).toBe('Nothing waiting for your approval.');
    });

    it('groups requests by run with the theme and who asked, and approves one with the one-off allow', async () => {
      await show(room());
      await openPanel();
      const panel = q('dock-approvals-panel')!;
      const run = panel.querySelector('[data-testid="dock-approval-run"]')!;
      expect(run.textContent).toContain('Launch');
      expect(run.textContent).toContain('you asked');
      expect(panel.textContent).toContain('2 waiting');
      const requests = all('dock-approval-request');
      expect(requests.map((r) => r.querySelector('code')!.textContent)).toEqual([
        'Read the numbers',
        'Write the review',
      ]);
      const buttons = [...requests[1]!.querySelectorAll('button')];
      expect(buttons.map((b) => b.textContent)).toEqual(['Reject', 'Approve']);
      await act(async () => click(buttons[1]!));
      expect(mocks.resolvePermission).toHaveBeenCalledWith({
        runId: 'r1',
        requestId: 'p2',
        optionId: 'allow-p2',
      });
    });

    it('rejects with the deny, and approves a whole run with "Approve all"', async () => {
      await show(room());
      await openPanel();
      const approveAll = [...q('dock-approvals-panel')!.querySelectorAll('button')].find(
        (b) => b.textContent === 'Approve all 2'
      )!;
      await act(async () => click(approveAll));
      expect(mocks.resolvePermission.mock.calls.map((c) => c[0])).toEqual([
        { runId: 'r1', requestId: 'p1', optionId: 'allow-p1' },
        { runId: 'r1', requestId: 'p2', optionId: 'allow-p2' },
      ]);
    });

    it('rejects with the deny', async () => {
      await show(room());
      await openPanel();
      await act(async () =>
        click([...all('dock-approval-request')[0]!.querySelectorAll('button')][0]!)
      );
      expect(mocks.resolvePermission).toHaveBeenLastCalledWith({
        runId: 'r1',
        requestId: 'p1',
        optionId: 'reject-p1',
      });
    });

    describe('feedback', () => {
      const buttonOf = (index: number, label: string) =>
        [...all('dock-approval-request')[index]!.querySelectorAll('button')].find(
          (b) => b.textContent === label
        )!;
      const requestTitles = () =>
        all('dock-approval-request').map((r) => r.querySelector('code')!.textContent);
      /** An answer that settles when the test says so. */
      const holdAnswers = () => {
        const settle: Array<(resolved: boolean) => void> = [];
        mocks.resolvePermission.mockImplementation(
          () => new Promise((resolve) => settle.push((resolved) => resolve({ resolved })))
        );
        return settle;
      };

      it('takes an answered request out of the panel, the badge and the For you pill at once', async () => {
        const settle = holdAnswers();
        await show(room());
        expect(q('dock-pill-for-you')!.textContent).toBe('For you1');
        await openPanel();
        await act(async () => click(buttonOf(0, 'Approve')));
        // The relay has not answered yet; the request is already gone.
        expect(requestTitles()).toEqual(['Write the review']);
        await until(() => expect(badge()!.textContent).toBe('1'));
        expect(q('dock-approvals-panel')!.textContent).toContain('1 waiting');
        await act(async () => settle[0]!(true));
        expect(requestTitles()).toEqual(['Write the review']);
        expect(mocks.toast).not.toHaveBeenCalled();
      });

      it('sends a double click once', async () => {
        holdAnswers();
        await show(room());
        await openPanel();
        const approve = buttonOf(0, 'Approve');
        await act(async () => {
          click(approve);
          click(approve);
        });
        expect(mocks.resolvePermission).toHaveBeenCalledTimes(1);
      });

      it('brings the request back and says what failed when the answer does not go through', async () => {
        const settle = holdAnswers();
        await show(room());
        await openPanel();
        await act(async () => click(buttonOf(1, 'Reject')));
        expect(requestTitles()).toEqual(['Read the numbers']);
        await act(async () => settle[0]!(false));
        expect(requestTitles()).toEqual(['Read the numbers', 'Write the review']);
        await until(() => expect(badge()!.textContent).toBe('2'));
        expect(mocks.toast).toHaveBeenCalledOnce();
        expect(mocks.toast.mock.calls[0]![0]).toMatchObject({
          title: 'Couldn’t reject that request',
        });
      });

      it('brings it back too when the call throws', async () => {
        mocks.resolvePermission.mockRejectedValue(new Error('ipc'));
        await show(room());
        await openPanel();
        await act(async () => click(buttonOf(0, 'Approve')));
        await until(() =>
          expect(requestTitles()).toEqual(['Read the numbers', 'Write the review'])
        );
        expect(mocks.toast.mock.calls[0]![0]).toMatchObject({
          title: 'Couldn’t approve that request',
        });
      });
    });

    it('names who asked when it was someone else, and has no "Approve all" for a single request', async () => {
      mocks.activity = [
        {
          ...ask('n1', 'm1'),
          type: 'agent_request',
          runId: 'r1',
          messageId: null,
          actor: { kind: 'user', userId: 'maya', name: 'Maya', agent: null },
        },
      ];
      await show(room({ sessionEventsByRun: { r1: permissionEvents('p1', 1) } }));
      await openPanel();
      expect(q('dock-approval-run')!.textContent).toContain('Maya asked');
      expect(
        [...q('dock-approvals-panel')!.querySelectorAll('button')].some((b) =>
          /Approve all/.test(b.textContent ?? '')
        )
      ).toBe(false);
    });

    it('closes on Esc without clearing the focus, and on a click outside', async () => {
      await show(room());
      await act(async () => click(all('dock-pill').find((p) => p.dataset.themeId === 'pricing')!));
      await sleep(80);
      await openPanel();
      expect(q('dock-approvals-panel')).not.toBeNull();
      await act(async () => void press('Escape'));
      await until(() => expect(q('dock-approvals-panel')).toBeNull());
      expect(q('dock-focus-card')).not.toBeNull();
      await openPanel();
      await act(async () => void pointerDownOutside());
      await until(() => expect(q('dock-approvals-panel')).toBeNull());
    });

    it('updates the badge and the pill dots when an answered request leaves the snapshot', async () => {
      await show(room());
      expect(badge()!.textContent).toBe('2');
      await show(room({ sessionEventsByRun: { r1: permissionEvents('p2', 3) } }));
      expect(badge()!.textContent).toBe('1');
    });
  });

  describe('the goo', () => {
    it('draws every shape in one filtered layer and every word, face and button above it', async () => {
      mocks.activity = [ask('n1', 'm2')];
      await show(room());
      expect(all('dock-goo')).toHaveLength(1);
      const layer = q('dock-goo')!;
      expect(shapes()).toEqual(['rail', 'for-you', 'theme:launch', 'theme:pricing', 'theme:lunch']);
      // Plain shapes: nothing to read, nothing to press.
      expect(layer.textContent).toBe('');
      expect(layer.querySelector('button, img, svg, [data-testid]')).toBeNull();
      // One filter, on the layer; the shadow is the layer's, so no shape has its own.
      const filtered = [...host.querySelectorAll<HTMLElement>('[style*="filter"]')];
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toBe(layer);
      expect(layer.getAttribute('style')).toContain('var(--dock-shadow)');
      for (const el of layer.querySelectorAll<HTMLElement>('[data-shape]')) {
        expect(el.style.boxShadow).toBe('');
        expect(el.style.border).toBe('');
        expect(el.style.background).toContain('--pill-fill');
      }
      // Above it: the content layer, with the rail and the pills, and not one shape.
      const content = q('dock-content')!;
      expect(layer.contains(content) || content.contains(layer)).toBe(false);
      expect(content.contains(q('dock-rail'))).toBe(true);
      expect(content.contains(q('dock-pill-for-you'))).toBe(true);
      for (const pill of all('dock-pill')) expect(content.contains(pill)).toBe(true);
      expect(content.querySelector('[data-shape]')).toBeNull();
      // No pill, and not the rail, wears a shadow, a blur or an edge of its own.
      for (const el of [q('dock-rail')!, q('dock-pill-for-you')!, ...all('dock-pill')]) {
        expect(el.querySelector('.shadow-float, .backdrop-blur-md')).toBeNull();
        expect(el.className).not.toMatch(/\b(border|shadow-\S+|backdrop-blur\S*)\b/);
      }
    });

    it('puts each shape exactly under what it holds', async () => {
      mocks.activity = [ask('n1', 'm2')];
      await show(room());
      for (const id of ['rail', 'for-you', 'theme:launch', 'theme:pricing', 'theme:lunch']) {
        expect(shape(id)!.dataset.edge).toBe(item(id)!.dataset.edge);
        expect(shape(id)!.dataset.width).toBe(item(id)!.dataset.width);
      }
    });

    it('hangs the peek from its pill on a neck in the same layer, and folds it back', async () => {
      await show(room());
      expect(shapes()).not.toContain('float');
      await act(async () => hover(all('dock-pill')[0]!));
      await until(() => expect(q('dock-peek')).not.toBeNull());
      await until(() => expect(shapes()).toEqual([...shapes().filter((id) => id !== 'float' && id !== 'float-neck'), 'float', 'float-neck']));
      expect(q('dock-goo')!.contains(shape('float'))).toBe(true);
      await act(async () => unhover(all('dock-pill')[0]!));
      await until(() => expect(q('dock-peek')).toBeNull());
      expect(shapes()).not.toContain('float');
    });

    it('hangs the approvals panel from the rail the same way', async () => {
      await show(room());
      await act(async () => click(q('dock-agent')!));
      // The panel's edge is the rail's edge and the gap, and the neck bridges them.
      await until(() => expect(Number(shape('float-neck')?.dataset.edge)).toBe(edge('rail') + 12));
      expect(q('dock-goo')!.contains(shape('float'))).toBe(true);
    });
  });

  describe('alignment: strictly left, ragged right', () => {
    /** Pills of every width: a short name, a long one, a middling one. */
    const mixed = () =>
      room({
        themes: themesOf(
          [
            theme('launch', 3, 5, 'Launch'),
            theme('pricing', 2, 3, 'Pricing and packaging for the relaunch week'),
            theme('lunch', 1, 1, 'Lunch'),
          ],
          { m1: 'lunch', m2: 'pricing', m3: 'pricing', m4: 'launch', m5: 'launch', s1: 'launch' }
        ),
      });

    it('gives every pill the column left edge, whatever its width, with the rail hugging its content', async () => {
      mocks.activity = [ask('n1', 'm2')];
      await show(mixed());
      const ids = ['for-you', 'theme:launch', 'theme:pricing', 'theme:lunch'];
      const railEdge = edge('rail');
      expect(railEdge).toBeGreaterThan(0);
      // Here the rail is narrower than 208: it keeps its natural width, a cap on the right of the column.
      expect(railEdge).toBeLessThan(208);
      for (const id of ids) expect(edge(id)).toBe(208);
      // Ragged on the right: the pills keep their own widths, none is wider than the column.
      expect(new Set(ids.map(width)).size).toBeGreaterThan(1);
      for (const id of ids) expect(width(id)).toBeLessThanOrEqual(208);
    });

    it('does not move any pill when a card opens: the card alone reaches further left', async () => {
      mocks.activity = [ask('n1', 'm2')];
      await show(mixed());
      const others = ['for-you', 'theme:launch', 'theme:lunch'];
      const before = others.map(edge);
      await act(async () => click(all('dock-pill').find((p) => p.dataset.themeId === 'pricing')!));
      await until(() => expect(q('dock-focus-card')).not.toBeNull());
      await sleep(80);
      expect(others.map(edge)).toEqual(before);
      expect(columnEdge()).toBe(before[0]);
      // Wider than the column's reach, so only the card shifts left; it never narrows below its width.
      expect(edge('theme:pricing')).toBe(Math.max(columnEdge(), 272));
      expect(width('theme:pricing')).toBe(272);
    });

    it("does not move any pill when For you swells: it keeps the rail's edge, or reaches left alone", async () => {
      await show(room({ sessionEventsByRun: {} }));
      await show(room({ sessionEventsByRun: {} }));
      mocks.activity = [ask('n1', 'm2', 'maya', 'Maya Papadopoulos-Whitcombe')];
      await show(room({ sessionEventsByRun: {} }));
      await until(() => expect(q('dock-pill-for-you')?.dataset.swell).toBe('mention'));
      await sleep(100);
      expect(edge('for-you')).toBe(Math.max(columnEdge(), width('for-you')));
      for (const id of ['theme:launch', 'theme:pricing', 'theme:lunch']) {
        expect(edge(id)).toBe(columnEdge());
      }
    });
  });

  describe('a birth', () => {
    it('is one element: a drop that grows out of the listener, slides into place and becomes the pill', async () => {
      await show(room());
      expect(item('theme:fresh')).toBeNull();
      await act(async () => root.render(<Harness snapshot={withBirth(room(), 'fresh', 'Space setup')} />));
      // No notice pill, anywhere: the theme is the only element it makes.
      expect(q('dock-notice')).toBeNull();
      expect(host.querySelectorAll('[data-dock-item="theme:fresh"]')).toHaveLength(1);
      expect(host.querySelectorAll('[data-shape="theme:fresh"]')).toHaveLength(1);
      // It starts as a drop no bigger than a dot, behind the listener, and the column makes room.
      expect(item('theme:fresh')!.dataset.phase).toBe('bead');
      expect(shape('theme:fresh')!.dataset.width).toBe('12');
      await until(() => expect(item('theme:fresh')!.dataset.phase).toBe('drop'));
      // The drop is under the rail, with the name alone.
      expect(Number(shape('theme:fresh')!.dataset.width)).toBeGreaterThan(12);
      expect(q('dock-pill-new')).not.toBeNull();
      await until(() => expect(item('theme:fresh')!.dataset.phase).toBe('placed'));
      // Then the pill, in its place at the column's left edge, first of the themes, with the tag.
      expect(edge('theme:fresh')).toBe(columnEdge());
      expect(pillNames()).toEqual(['fresh', 'launch', 'pricing', 'lunch']);
      expect(q('dock-pill-new')!.closest('[data-testid="dock-pill"]')).toBe(all('dock-pill')[0]);
      expect(all('dock-pill-new')).toHaveLength(1);
    });

    it('drops the "new" tag after a few seconds, and counts a birth once however often the Room re-renders', async () => {
      await show(room());
      await show(withBirth(room()));
      await until(() => expect(item('theme:fresh')!.dataset.phase).toBe('placed'));
      await show(withBirth(room()));
      await show(withBirth(room()));
      // No second drop, one tag.
      expect(item('theme:fresh')!.dataset.phase).toBe('placed');
      expect(all('dock-pill-new')).toHaveLength(1);
      await until(() => expect(all('dock-pill-new')).toHaveLength(0));
      expect(pillNames()).toContain('fresh');
    });

    it('has the default clocks: the new tag lasts four seconds, a swell four seconds', () => {
      expect(DEFAULT_TIMING.newTagMs).toBe(4000);
      expect(DEFAULT_TIMING.swellMs).toBe(4000);
      expect(DEFAULT_TIMING.settleAfterMs).toBeLessThan(2000);
    });

    it('skips the trip with reduced motion', async () => {
      mocks.reducedMotion = true;
      await show(room());
      await act(async () => root.render(<Harness snapshot={withBirth(room())} />));
      expect(item('theme:fresh')!.dataset.phase).toBe('placed');
      expect(all('dock-pill-new')).toHaveLength(1);
    });
  });

  describe('For you swells on an arrival', () => {
    const pill = () => q('dock-pill-for-you')!;
    const noSessions = () => room({ sessionEventsByRun: {} });

    it('says who mentioned you, with their face, then folds back to "For you N"', async () => {
      await show(noSessions());
      mocks.activity = [ask('n1', 'm2')];
      await show(noSessions());
      await until(() => expect(pill().dataset.swell).toBe('mention'));
      // The face comes first: its initial is the first letter.
      expect(pill().textContent).toBe('MMaya mentioned you1');
      // One element, no notice beside it.
      expect(all('dock-pill-for-you')).toHaveLength(1);
      expect(q('dock-notice')).toBeNull();
      await until(() => expect(pill().dataset.swell).toBeUndefined());
      expect(pill().textContent).toBe('For you1');
    });

    it('says who replied, and who commented, from the notification type', async () => {
      await show(noSessions());
      mocks.activity = [{ ...ask('n1', 'm2'), type: 'reply' }];
      await show(noSessions());
      await until(() => expect(pill().dataset.swell).toBe('reply'));
      expect(pill().textContent).toBe('MMaya replied to you1');
      await until(() => expect(pill().dataset.swell).toBeUndefined());
      mocks.activity = [
        { ...ask('n1', 'm2'), type: 'reply' },
        { ...ask('n2', 'm5', 'sam', 'Sam'), type: 'comment' },
      ];
      await show(noSessions());
      await until(() => expect(pill().dataset.swell).toBe('comment'));
      expect(pill().textContent).toBe('SSam commented for you2');
    });

    it('says your agent needs approval for a request', async () => {
      await show(noSessions());
      await show(room());
      await until(() => expect(pill().dataset.swell).toBe('approval'));
      expect(pill().textContent).toBe('DYour Claude needs approval1');
    });

    it('is born like a theme first when For you was not showing, and swells once it is in place', async () => {
      await show(noSessions());
      expect(q('dock-pill-for-you')).toBeNull();
      mocks.activity = [ask('n1', 'm2')];
      await act(async () => root.render(<Harness snapshot={noSessions()} />));
      await until(() => expect(item('for-you')).not.toBeNull());
      expect(item('for-you')!.dataset.phase).toBe('bead');
      expect(shape('for-you')!.dataset.width).toBe('12');
      expect(pill().dataset.swell).toBeUndefined();
      await until(() => expect(item('for-you')!.dataset.phase).toBe('drop'));
      await until(() => expect(item('for-you')!.dataset.phase).toBe('placed'));
      // Only then does it swell.
      await until(() => expect(pill().dataset.swell).toBe('mention'));
      expect(item('for-you')!.dataset.phase).toBe('placed');
      await until(() => expect(pill().dataset.swell).toBeUndefined());
    });

    it('takes arrivals one at a time: the second waits for the first to fold back', async () => {
      mocks.activity = [ask('n1', 'm2')];
      await show(noSessions());
      expect(pill().dataset.swell).toBeUndefined();
      // An ask from Sam and a request on your agent arrive together.
      mocks.activity = [ask('n1', 'm2'), ask('n2', 'm5', 'sam', 'Sam')];
      await show(room());
      await until(() => expect(pill().dataset.swell).toBe('mention'));
      expect(pill().textContent).toBe('SSam mentioned you3');
      await until(() => expect(pill().dataset.swell).toBe('approval'));
      expect(pill().textContent).toBe('DYour Claude needs approval3');
      await until(() => expect(pill().dataset.swell).toBeUndefined());
      expect(pill().textContent).toBe('For you3');
    });

    it('does not swell for what was there when the Room opened', async () => {
      mocks.activity = [ask('n1', 'm2')];
      await show(room());
      expect(pill().dataset.swell).toBeUndefined();
      expect(item('for-you')!.dataset.phase).toBe('placed');
      // One ask, and one run to approve.
      expect(pill().textContent).toBe('For you2');
    });

    it('shows no swell while For you is focused as a card', async () => {
      await show(noSessions());
      mocks.activity = [ask('n1', 'm2')];
      await show(noSessions());
      await until(() => expect(pill().dataset.swell).toBe('mention'));
      await act(async () => click(pill()));
      await until(() => expect(q('dock-focus-card')).not.toBeNull());
      expect(q('dock-pill-for-you')).toBeNull();
    });
  });

  describe('hovering a pill dims the rest of the transcript', () => {
    it('dims the rows a hovered theme does not hold, and restores them on leave', async () => {
      await show(room());
      expect(dimmedRows()).toEqual([]);
      const pricing = all('dock-pill').find((p) => p.dataset.themeId === 'pricing')!;
      await act(async () => hover(pricing));
      expect(dimmedRows()).toEqual(['m1', 'm4', 'm5', 's1']);
      await act(async () => unhover(pricing));
      expect(dimmedRows()).toEqual([]);
    });

    it('does the same for For you: what holds an ask or an approval stays, the rest dims', async () => {
      mocks.activity = [ask('n1', 'm2')];
      await show(room());
      await act(async () => hover(q('dock-pill-for-you')!));
      expect(dimmedRows()).toEqual(['m1', 'm3', 'm4', 'm5']);
      await act(async () => unhover(q('dock-pill-for-you')!));
      expect(dimmedRows()).toEqual([]);
    });

    it('moves with the hover from one pill to the next', async () => {
      await show(room());
      const [launch, pricing] = [all('dock-pill')[0]!, all('dock-pill')[1]!];
      await act(async () => hover(launch));
      expect(dimmedRows()).toEqual(['m1', 'm2', 'm3']);
      await act(async () => {
        unhover(launch);
        hover(pricing);
      });
      expect(dimmedRows()).toEqual(['m1', 'm4', 'm5', 's1']);
    });

    it('leaves a focused transcript alone: the rest is already folded', async () => {
      await show(room());
      await act(async () => click(all('dock-pill').find((p) => p.dataset.themeId === 'pricing')!));
      await sleep(80);
      await act(async () => hover(all('dock-pill')[0]!));
      expect(dimmedRows()).toEqual([]);
    });
  });

  describe('the pinned panel', () => {
    it('lets go of the focus when the panel opens, so the transcript is not left filtered with no card', async () => {
      const onExpand = vi.fn();
      await show(room(), onExpand);
      await act(async () => click(all('dock-pill').find((p) => p.dataset.themeId === 'pricing')!));
      await sleep(100);
      expect(rows()).toEqual(['fold', 'm2', 'm3', 'fold']);
      await act(async () => click(q('dock-toggle')!));
      expect(onExpand).toHaveBeenCalledOnce();
      await sleep(100);
      expect(rows()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 's1']);
      expect(q('dock-focus-card')).toBeNull();
    });
  });

  describe('the panel: the rail becomes it, and back', () => {
    const open = async () => {
      await show(room(), undefined, false, true);
      await act(async () => click(q('dock-toggle')!));
      await sleep(60);
    };
    const cardRadius = () => shape('rail')!.style.borderRadius;
    /** The computed transition of one property of an element: seconds. */
    const timing = (el: HTMLElement, property: string) => {
      const cs = getComputedStyle(el);
      const i = cs.transitionProperty.split(', ').indexOf(property);
      return {
        duration: parseFloat(cs.transitionDuration.split(', ')[i] ?? 'NaN'),
        delay: parseFloat(cs.transitionDelay.split(', ')[i] ?? 'NaN'),
      };
    };
    /** A shape's own radius at rest is half its height; the panel's is the dock card's 16. */
    const capsule = () => `${parseFloat(shape('rail')!.style.height) / 2}px`;

    it("morphs the rail's own shape to the panel's bounds and radius, and folds the column into it", async () => {
      await show(room(), undefined, false, true);
      const railW = width('rail');
      expect(all('dock-pill').length).toBeGreaterThan(0);
      const shapesBefore = shapes();
      expect(cardRadius()).toBe(capsule());
      await act(async () => click(q('dock-toggle')!));
      await sleep(60);
      // One shape, the rail's: no second shape for the panel.
      expect(shapes().filter((id) => id === 'rail')).toHaveLength(1);
      expect(shapes()).not.toContain('card');
      expect(shape('rail')!.dataset.width).toBe('304');
      expect(Number(shape('rail')!.style.height.replace('px', ''))).toBe(260);
      expect(cardRadius()).toBe('16px');
      expect(railW).toBeLessThan(304);
      // The same spring as every other shape of the dock, and the same goo layer.
      expect(timing(shape('rail')!, 'width').duration).toBe(0.6);
      expect(timing(shape('rail')!, 'border-radius').duration).toBe(0.6);
      expect(shape('rail')!.parentElement).toBe(q('dock-goo'));
      // The column tucks away.
      expect(shapesBefore.length).toBeGreaterThan(1);
      await until(() => expect(all('dock-pill')).toHaveLength(0));
      await until(() => expect(shapes()).toEqual(['rail']));
      expect(q('dock-card')!.dataset.open).toBe('true');
      expect(q('card-body')).not.toBeNull();
    });

    it("follows the panel's height closely once it has settled, so an opening section is not left behind", async () => {
      await open();
      expect(timing(shape('rail')!, 'height').duration).toBe(0.6);
      await sleep(700);
      expect(timing(shape('rail')!, 'height').duration).toBe(0.2);
      expect(timing(shape('rail')!, 'border-radius').duration).toBe(0.2);
      await act(async () => click(q('dock-toggle')!));
      await sleep(60);
      expect(timing(shape('rail')!, 'height').duration).toBe(0.6);
    });

    it("swaps the content in two beats: the rail's leaves at once, the panel's arrives once the shape is mostly open", async () => {
      await open();
      // The rail's content is gone (and out of the keyboard's way) and quick about it.
      expect(item('rail')!.style.opacity).toBe('0');
      expect(item('rail')!.inert).toBe(true);
      expect(timing(item('rail')!, 'opacity').duration).toBe(0.1);
      // The panel's waits for about 70% of the spring (the shape takes 0.6s).
      expect(item('card')!.style.opacity).toBe('1');
      expect(timing(item('card')!, 'opacity')).toEqual({ duration: 0.25, delay: 0.42 });
      expect(item('card')!.inert).toBeFalsy();
    });

    it('keeps one chevron, in the same place, that turns to point up and fold the panel back', async () => {
      await show(room(), undefined, false, true);
      const toggle = q('dock-toggle')!;
      const corner = q('dock-corner')!;
      const rect = () => toggle.getBoundingClientRect();
      const before = { x: rect().x, y: rect().y };
      await act(async () => click(toggle));
      await sleep(60);
      // The very same element, in the same place, now turned up and labelled for folding.
      expect(q('dock-toggle')).toBe(toggle);
      expect(q('dock-corner')).toBe(corner);
      expect(toggle.getAttribute('aria-label')).toBe('Fold into the rail');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(q('dock-toggle-icon')!.style.transform).toBe('rotate(180deg)');
      expect(q('dock-toggle-icon')!.style.transition).toContain('transform 0.6s');
      expect({ x: rect().x, y: rect().y }).toEqual(before);
      expect(host.querySelectorAll('[data-testid="dock-toggle"]')).toHaveLength(1);
      await act(async () => click(toggle));
      await sleep(60);
      expect(q('dock-toggle')).toBe(toggle);
      expect(toggle.getAttribute('aria-label')).toBe('Open Space details');
      expect(q('dock-toggle-icon')!.style.transform).toBe('rotate(0deg)');
      expect({ x: rect().x, y: rect().y }).toEqual(before);
    });

    it("folds back: the shape returns to the rail's bounds, the panel's content leaves at once and the rail's returns late", async () => {
      await open();
      await act(async () => click(q('dock-toggle')!));
      await sleep(60);
      // Mid-fold: the panel stays mounted but quiet, the shape heads back, the rail's content waits for it.
      expect(q('dock-card')!.dataset.open).toBe('false');
      expect(item('card')!.style.opacity).toBe('0');
      expect(item('card')!.inert).toBe(true);
      expect(timing(item('card')!, 'opacity').duration).toBe(0.12);
      expect(item('rail')!.style.opacity).toBe('1');
      expect(timing(item('rail')!, 'opacity')).toEqual({ duration: 0.25, delay: 0.42 });
      expect(cardRadius()).toBe(capsule());
      expect(shape('rail')!.dataset.width).toBe(String(width('rail')));
      // Then the panel is gone and the column is back.
      await until(() => expect(q('dock-card')).toBeNull());
      await until(() => expect(all('dock-pill').length).toBeGreaterThan(0));
    });

    it('swaps instantly with reduced motion', async () => {
      mocks.reducedMotion = true;
      await open();
      expect(timing(shape('rail')!, 'width').duration).toBe(0);
      expect(timing(shape('rail')!, 'border-radius').duration).toBe(0);
      expect(timing(item('card')!, 'opacity').delay).toBe(0);
      expect(timing(item('rail')!, 'opacity').delay).toBe(0);
      expect(q('dock-toggle-icon')!.style.transition).toBe('none');
      await act(async () => click(q('dock-toggle')!));
      await sleep(30);
      // No lingering panel, no waiting: the rail is back at once.
      expect(q('dock-card')).toBeNull();
      expect(item('rail')!.style.opacity).toBe('1');
    });

    it('sizes the dock to the panel while it is open', async () => {
      await show(room(), undefined, false, true);
      expect(q('theme-dock')!.style.width).not.toBe('304px');
      await act(async () => click(q('dock-toggle')!));
      await sleep(60);
      expect(q('theme-dock')!.style.width).toBe('304px');
    });

    it('closes the approvals panel and any hovered peek when the panel opens', async () => {
      await show(room(), undefined, false, true);
      await act(async () => click(q('dock-agent')!));
      await sleep(80);
      expect(q('dock-float')).not.toBeNull();
      await act(async () => click(q('dock-toggle')!));
      await sleep(60);
      expect(q('dock-agent')!.getAttribute('aria-expanded')).toBe('false');
      await until(() => expect(q('dock-float')).toBeNull());
    });

    it('opens at People from the rail\'s "+N"', async () => {
      const people = Array.from({ length: 8 }, (_, i) => ({
        id: `p${i}`,
        name: `Person ${i}`,
        email: '',
        role: 'editor',
        initial: 'P',
        status: 'here' as const,
      }));
      const onExpand = vi.fn();
      await show(room({ members: [room().members[0]!, ...people] }), onExpand, false, true);
      await act(async () => click(q('dock-members-more')!));
      await sleep(60);
      expect(onExpand).toHaveBeenCalledWith('people');
      expect(q('dock-card')!.dataset.open).toBe('true');
    });
  });

  describe('a narrow Room', () => {
    const narrow = (snapshot: RoomSnapshot = room()) => show(snapshot, undefined, true);

    it('shows For you and one "Themes N" pill under the rail, not every theme', async () => {
      mocks.activity = [ask('n1', 'm2')];
      await narrow();
      expect(q('dock-rail')).not.toBeNull();
      expect(all('dock-pill')).toHaveLength(0);
      const pills = [...q('dock-pills')!.querySelectorAll('button')];
      expect(pills.map((b) => b.dataset.testid)).toEqual(['dock-pill-for-you', 'dock-themes']);
      expect(q('dock-themes')!.textContent).toBe('Themes3');
    });

    it('has only the Themes pill when nothing waits on you, and nothing when there are no themes', async () => {
      await narrow(room({ sessionEventsByRun: {} }));
      expect([...q('dock-pills')!.querySelectorAll('button')].map((b) => b.dataset.testid)).toEqual(
        ['dock-themes']
      );
      await narrow(room({ sessionEventsByRun: {}, themes: themesOf([], {}) }));
      await until(() => expect(q('dock-pills')).toBeNull());
    });

    it('opens the list of themes, focuses one as a card, and lists the rest', async () => {
      await narrow(room({ sessionEventsByRun: {} }));
      await act(async () => click(q('dock-themes')!));
      await sleep(80);
      expect(all('dock-more-item').map((i) => i.dataset.themeId)).toEqual([
        'launch',
        'pricing',
        'lunch',
      ]);
      await act(async () => click(all('dock-more-item')[1]!));
      await sleep(120);
      expect(q('dock-focus-card')?.textContent).toContain('Pricing');
      expect(rows()).toEqual(['fold', 'm2', 'm3', 'fold']);
      // The card stands in for the pill, and the list is now the others.
      expect(q('dock-themes')!.textContent).toBe('Themes2');
      await act(async () => click(q('dock-themes')!));
      await sleep(80);
      expect(all('dock-more-item').map((i) => i.dataset.themeId)).toEqual(['launch', 'lunch']);
      await act(async () => click(q('dock-focus-clear')!));
      await sleep(100);
      expect(q('dock-themes')!.textContent).toBe('Themes3');
    });
  });

  describe('the keyboard', () => {
    const focused = () => document.activeElement as HTMLElement | null;
    // The tests load no Tailwind, so the ring is checked as the class that draws it.
    const hasRing = (el: HTMLElement) => el.className.includes('focus-visible:ring-2');
    // Real key presses open tooltips and the like outside `act`; these tests wait with `until` instead.
    const flag = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
    const showForKeys = async (...args: Parameters<typeof show>) => {
      await show(...args);
      flag.IS_REACT_ACT_ENVIRONMENT = false;
    };
    afterEach(() => {
      flag.IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('reaches the pills with Tab, with a ring, and Enter or Space focuses a theme', async () => {
      mocks.activity = [ask('n1', 'm2')];
      await showForKeys(room(), vi.fn());
      q('dock-toggle')!.focus();
      await userEvent.tab();
      expect(focused()).toBe(q('dock-pill-for-you'));
      expect(hasRing(focused()!)).toBe(true);
      await userEvent.tab();
      expect(focused()).toBe(all('dock-pill')[0]);
      expect(hasRing(focused()!)).toBe(true);
      // Enter on the next one focuses that theme; the keyboard goes to the card's ×.
      await userEvent.tab();
      expect(focused()?.dataset.themeId).toBe('pricing');
      await userEvent.keyboard('{Enter}');
      await until(() => expect(q('dock-focus-card')?.textContent).toContain('Pricing'));
      await until(() => expect(focused()).toBe(q('dock-focus-clear')));
      expect(rows()).toEqual(['fold', 'm2', 'm3', 'fold']);
      // Enter on the × lets go, and the keyboard is back on the pill.
      await userEvent.keyboard('{Enter}');
      await until(() => expect(q('dock-focus-card')).toBeNull());
      await until(() => expect(focused()?.dataset.themeId).toBe('pricing'));
      // Space does the same as Enter.
      await userEvent.keyboard(' ');
      await until(() => expect(q('dock-focus-card')?.textContent).toContain('Pricing'));
    });

    it('dims the rest of the transcript for the pill the keyboard is on, and restores it when it leaves', async () => {
      await showForKeys(room({ sessionEventsByRun: {} }), vi.fn());
      q('dock-toggle')!.focus();
      await userEvent.tab();
      expect(focused()).toBe(all('dock-pill')[0]);
      await until(() => expect(dimmedRows()).toEqual(['m1', 'm2', 'm3']));
      await userEvent.tab();
      await until(() => expect(dimmedRows()).toEqual(['m1', 'm4', 'm5', 's1']));
      q('dock-toggle')!.focus();
      await until(() => expect(dimmedRows()).toEqual([]));
    });

    it('lets Esc clear a focus and hands the keyboard back to the pill', async () => {
      await showForKeys(room());
      all('dock-pill')[1]!.focus();
      await userEvent.keyboard('{Enter}');
      await until(() => expect(focused()).toBe(q('dock-focus-clear')));
      await userEvent.keyboard('{Escape}');
      await until(() => expect(q('dock-focus-card')).toBeNull());
      await until(() => expect(focused()?.dataset.themeId).toBe('pricing'));
    });

    it('moves into the approvals panel when it opens, and back to the agent when it closes', async () => {
      await showForKeys(room());
      const agent = q('dock-agent')!;
      agent.focus();
      await userEvent.keyboard('{Enter}');
      await until(() => expect(q('dock-approvals-panel')).not.toBeNull());
      const panel = q('dock-approvals-panel')!;
      expect(panel.getAttribute('role')).toBe('dialog');
      expect(panel.getAttribute('aria-label')).toBe('Your Claude approvals');
      expect(panel.contains(focused())).toBe(true);
      // Tab goes on to its buttons.
      await userEvent.tab();
      expect(panel.contains(focused())).toBe(true);
      expect(focused()?.tagName).toBe('BUTTON');
      await userEvent.keyboard('{Escape}');
      await until(() => expect(q('dock-approvals-panel')).toBeNull());
      expect(focused()).toBe(agent);
    });

    it('keeps the keyboard in the panel when the request it pressed leaves', async () => {
      await showForKeys(room());
      q('dock-agent')!.focus();
      await userEvent.keyboard('{Enter}');
      await until(() => expect(q('dock-approvals-panel')).not.toBeNull());
      await userEvent.tab();
      await userEvent.tab();
      expect(focused()?.textContent).toBe('Approve');
      await userEvent.keyboard('{Enter}');
      await until(() => expect(all('dock-approval-request')).toHaveLength(1));
      expect(q('dock-approvals-panel')!.contains(focused())).toBe(true);
    });

    describe('the list of themes', () => {
      const crowd = () => {
        const list = Array.from({ length: 8 }, (_, i) => theme(`t${i}`, 1, 10 + i, `Topic ${i}`));
        return room({
          messages: list.map((_, i) => msg(`x${i}`, 10 + i)),
          sessionEventsByRun: {},
          sessionMetaByRun: {},
          themes: themesOf(list, Object.fromEntries(list.map((t, i) => [`x${i}`, t.id]))),
        });
      };

      it('takes the keyboard when it opens, moves with the arrows, and gives it back on Esc', async () => {
        await showForKeys(crowd());
        const trigger = q('dock-more')!;
        trigger.focus();
        await userEvent.keyboard('{Enter}');
        await until(() => expect(q('dock-more-list')).not.toBeNull());
        await until(() => expect(focused()).toBe(all('dock-more-item')[0]));
        await userEvent.keyboard('{ArrowDown}');
        expect(focused()).toBe(all('dock-more-item')[1]);
        await userEvent.keyboard('{ArrowUp}');
        expect(focused()).toBe(all('dock-more-item')[0]);
        await userEvent.keyboard('{Escape}');
        await until(() => expect(q('dock-more-list')).toBeNull());
        expect(focused()).toBe(trigger);
        expect(q('dock-focus-card')).toBeNull();
      });

      it('picks a theme with Enter, and the keyboard goes to its card', async () => {
        await showForKeys(crowd());
        q('dock-more')!.focus();
        await userEvent.keyboard('{Enter}');
        await until(() => expect(focused()).toBe(all('dock-more-item')[0]));
        await userEvent.keyboard('{ArrowDown}{Enter}');
        await until(() => expect(q('dock-focus-card')?.textContent).toContain('Topic 0'));
        await until(() => expect(focused()).toBe(q('dock-focus-clear')));
      });
    });
  });

  describe('reduced motion', () => {
    it('draws and works the same', async () => {
      mocks.reducedMotion = true;
      mocks.activity = [ask('n1', 'm2')];
      await show(room());
      expect(pillNames()).toEqual(['launch', 'pricing', 'lunch']);
      expect(q('dock-approvals-badge')!.textContent).toBe('2');
      await act(async () => click(all('dock-pill')[0]!));
      expect(q('dock-focus-card')).not.toBeNull();
      expect(rows()).toEqual(['fold', 'm4', 'm5', 's1']);
      await act(async () => click(q('dock-focus-clear')!));
      expect(q('dock-focus-card')).toBeNull();
      await act(async () => click(q('dock-agent')!));
      expect(q('dock-approvals-panel')).not.toBeNull();
      await act(async () => void press('Escape'));
      expect(q('dock-approvals-panel')).toBeNull();
      await act(async () => click(all('dock-pill-for-you')[0]!));
      expect(q('dock-focus-card')!.textContent).toContain('Maya asked you directly.');
    });
  });

  describe('the Room', () => {
    // The scripted demo, through RoomView: the connection fails, so the Room offers it.
    const openDemo = async (flag: boolean, spaceName = 'Room', width = 1200) => {
      mocks.roomThemesEnabled = flag;
      mocks.activity = null;
      const queryClient = new QueryClient();
      const renderRoom = (bindingId: string) =>
        act(async () =>
          root.render(
            <QueryClientProvider client={queryClient}>
              <div style={{ height: 720, width }} className="relative">
                <RoomView bindingId={bindingId} spaceName={spaceName} />
              </div>
            </QueryClientProvider>
          )
        );
      await renderRoom('b1');
      await until(() => expect(host.textContent).toContain('Could not connect'));
      await act(async () =>
        click(
          [...host.querySelectorAll('button')].find((b) =>
            /scripted demo/.test(b.textContent ?? '')
          )!
        )
      );
      // The demo plays itself, and in one beat it is over at once.
      await until(() => expect(host.textContent).toContain('added the relaunch date'));
      await sleep(300);
      return { switchTo: renderRoom };
    };

    it('with the flag off is the Room as it was: no dock, the space card', async () => {
      await openDemo(false);
      expect(q('theme-dock')).toBeNull();
      expect(q('space-card')).not.toBeNull();
    });

    it('lets go of the focus and the approvals panel when another Space opens', async () => {
      const { switchTo } = await openDemo(true);
      await act(async () => click(q('dock-pill-for-you')!));
      await sleep(100);
      expect(q('dock-focus-card')).not.toBeNull();
      expect(all('transcript-fold').length).toBeGreaterThan(0);
      await act(async () => click(q('dock-agent')!));
      await sleep(80);
      expect(q('dock-approvals-panel')).not.toBeNull();

      await switchTo('b2');
      await until(() => expect(host.textContent).toContain('added the relaunch date'));
      await sleep(300);
      expect(q('dock-focus-card')).toBeNull();
      expect(q('dock-approvals-panel')).toBeNull();
      expect(all('transcript-fold')).toHaveLength(0);
      expect(q('dock-pill-for-you')).not.toBeNull();
    });

    it('opens on the theme Home asked for, once its themes are in', async () => {
      const { switchTo } = await openDemo(true);
      const pill = all('dock-pill').at(-1)!;
      const themeId = pill.dataset.themeId!;
      const pillName = pill.textContent!.replace(/\d.*$/, '').trim();
      expect(q('dock-focus-card')).toBeNull();

      requestRoomTheme('b2', themeId);
      await switchTo('b2');
      await until(() => expect(q('dock-focus-card')).not.toBeNull());
      expect(q('dock-focus-card')!.textContent).toContain(pillName);
      expect(all('transcript-fold').length).toBeGreaterThan(0);
    });

    it('answers the demo approvals in its fixture: the request leaves, the real call is never made', async () => {
      await openDemo(true);
      expect(q('dock-approvals-badge')!.textContent).toBe('2');
      await act(async () => click(q('dock-agent')!));
      await sleep(80);
      const buttonOf = (index: number, label: string) =>
        [...all('dock-approval-request')[index]!.querySelectorAll('button')].find(
          (b) => b.textContent === label
        )!;
      await act(async () => click(buttonOf(0, 'Reject')));
      await until(() => expect(all('dock-approval-request')).toHaveLength(1));
      await until(() => expect(q('dock-approvals-badge')!.textContent).toBe('1'));
      await act(async () => click(buttonOf(0, 'Approve')));
      await until(() => expect(q('dock-approvals-empty')).not.toBeNull());
      await until(() => expect(q('dock-approvals-badge')).toBeNull());
      expect(mocks.resolvePermission).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
    });

    it('keeps the dock clear of the conversation in a narrow Room: a short column, and a gutter', async () => {
      await openDemo(true, 'Room', 800);
      expect(all('dock-pill')).toHaveLength(0);
      expect(q('dock-themes')!.textContent).toBe('Themes4');
      expect(q('dock-pill-for-you')).not.toBeNull();
      const column = host
        .querySelector<HTMLElement>('[data-testid="room-transcript"]')!
        .closest<HTMLElement>('[style*="padding-right"]')!;
      await until(() => expect(parseFloat(column.style.paddingRight)).toBeGreaterThan(100));
      // The transcript gives the dock all of its width, plus the dock's inset from the edge and a gap.
      const dockWidth = Math.ceil(q('theme-dock')!.getBoundingClientRect().width);
      await until(() => expect(parseFloat(column.style.paddingRight)).toBe(dockWidth + 16 + 12));
    });

    it('with the flag on shows the dock for the scripted demo, filled in', async () => {
      await openDemo(true);
      expect(q('theme-dock')).not.toBeNull();
      expect(q('space-card')).toBeNull();
      // Four themes covering the feed, For you with two asks and a run to approve.
      expect(all('dock-pill')).toHaveLength(4);
      // The arrivals swell it first; it folds back to its count.
      await until(() => expect(q('dock-pill-for-you')!.textContent).toBe('For you3'));
      expect(q('dock-approvals-badge')!.textContent).toBe('2');
      // The transcript keeps clear of the pills, by as much as they reach into its column.
      const column = host
        .querySelector<HTMLElement>('[data-testid="room-transcript"]')!
        .closest<HTMLElement>('[style*="padding-right"]')!;
      const gutter = Math.ceil(q('theme-dock')!.getBoundingClientRect().width) + 16 + 12;
      await until(() =>
        expect(parseFloat(column.style.paddingRight)).toBe(
          Math.min(gutter, Math.max(0, 728 + 2 * gutter - 1200))
        )
      );
    });
  });
});
