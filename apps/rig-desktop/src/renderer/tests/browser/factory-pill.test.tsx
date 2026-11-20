import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FactoryPill } from '@renderer/features/spaces/components/factory-pill';
import type { RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';
import { useDockFocus } from '@renderer/features/spaces/use-dock-focus';
import { TooltipProvider } from '@renderer/lib/ui/tooltip';
import type { SpaceState } from '@shared/rig/space-state';
import type { ViewManifest } from '@shared/rig/views';
import '@renderer/tokens.css';

const mocks = vi.hoisted(() => ({ spaceState: null as unknown }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      spaceState: { get: async () => mocks.spaceState },
      sessions: { listSessions: async () => [] },
    },
  },
  events: { on: () => () => {} },
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const SELF = 'me';
const NOW = Date.now();
const H = 3_600_000;

const msg = (id: string, seq: number): RoomMessage => ({
  id,
  seq,
  authorId: 'sam',
  createdAt: new Date(NOW).toISOString(),
  time: '10:00',
  body: id,
  meta: { kind: 'text' },
});

const snapshot = (): RoomSnapshot => ({
  name: 'launch',
  ready: true,
  members: [
    { id: SELF, name: 'Dylan', email: 'd@x.co', role: 'owner', initial: 'D', status: 'here' },
    { id: 'sam', name: 'Sam', email: 's@x.co', role: 'editor', initial: 'S', status: 'here' },
  ],
  agents: [{ agent: 'claude', owner: SELF, model: 'opus', busy: false }],
  connectors: [],
  skills: [],
  messages: [msg('m1', 1), msg('m2', 2)],
  invitesById: {},
  sessionMetaByRun: {},
  sessionEventsByRun: {},
  typingUserIds: [],
  themes: {
    enabled: true,
    list: [{ id: 'pricing', name: 'Pricing', description: '', bornSeq: 1, count: 2, lastSeq: 2 }],
    themeOf: { m1: { themeId: 'pricing', via: 'jev' }, m2: { themeId: 'pricing', via: 'jev' } },
    cursor: '1',
  },
});

const view = (over: Partial<ViewManifest> = {}): ViewManifest => ({
  name: 'bugs',
  kind: 'board',
  icon: null,
  order: null,
  title: 'Bug fixes',
  sub: null,
  counts: null,
  failed: false,
  note: null,
  updatedMs: NOW - 21 * H,
  every: null,
  everyMs: null,
  ...over,
});

function Harness({
  views,
  room: given,
  onOpenView,
  onPreview,
}: {
  views: ViewManifest[];
  room?: RoomSnapshot;
  onOpenView: (name: string) => void;
  onPreview: (ids: ReadonlySet<string> | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const room = React.useMemo(() => given ?? snapshot(), [given]);
  const focus = useDockFocus({
    enabled: true,
    snapshot: room,
    themes: room.themes,
    forYou: null,
    dismiss: null,
  });
  return (
    <div className="relative overflow-hidden" style={{ height: 640, width: 900 }}>
      <FactoryPill
        bindingId="b1"
        views={views}
        onOpenView={onOpenView}
        snapshot={room}
        selfUserId={SELF}
        forYouState={null}
        focus={focus}
        onExpand={() => setOpen(true)}
        card={{
          open,
          content: open ? (
            <div data-testid="card-body" style={{ width: 304, height: 260 }}>
              Space settings
            </div>
          ) : null,
          onFold: () => setOpen(false),
        }}
        mine={{ bindingId: 'b1', onOpen: () => {} }}
        onPreviewChange={onPreview}
      />
    </div>
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  mocks.spaceState = null;
});

async function show(views: ViewManifest[] = [view()], room?: RoomSnapshot) {
  const onOpenView = vi.fn();
  const onPreview = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <Harness views={views} room={room} onOpenView={onOpenView} onPreview={onPreview} />
        </TooltipProvider>
      </QueryClientProvider>
    );
  });
  await until(() => expect(shape('pill')).not.toBeNull());
  return { onOpenView, onPreview };
}

const q = (testId: string) => host!.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const shape = (id: string) => host!.querySelector<HTMLElement>(`[data-shape="${id}"]`);
const until = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 40 });
const over = (el: Element, type: 'mouseover' | 'mouseout') =>
  act(async () => void el.dispatchEvent(new MouseEvent(type, { bubbles: true })));
const click = (el: Element) =>
  act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('Factory pill', () => {
  it('stands flush on the right edge: the pill and its wall reach past the edge', async () => {
    await show();
    const stage = q('factory-pill')!.getBoundingClientRect();
    await until(() => {
      const pill = shape('pill')!.getBoundingClientRect();
      expect(pill.right).toBeGreaterThan(stage.right);
      expect(Math.round(stage.right - pill.left)).toBe(40);
    });
    const wall = shape('wall')!.getBoundingClientRect();
    const pill = shape('pill')!.getBoundingClientRect();
    // The wall itself is past the edge; it runs above and below the pill for the goo's fillets.
    expect(wall.left).toBeGreaterThanOrEqual(stage.right);
    expect(wall.top).toBeLessThan(pill.top);
    expect(wall.bottom).toBeGreaterThan(pill.bottom);
  });

  it('with no agent, no loop and no topic there is no pill until its spot is pointed at', async () => {
    await show([view()], { ...snapshot(), agents: [], themes: undefined });
    const stage = q('factory-pill')!;
    const edge = stage.getBoundingClientRect().right;
    expect(stage.dataset.empty).toBe('true');
    expect(q('dock-agents')).toBeNull();
    // At rest both shapes wait past the edge, further out than their shadow reaches.
    await until(() => {
      expect(shape('pill')!.getBoundingClientRect().left).toBeGreaterThanOrEqual(edge + 16);
      expect(shape('wall')!.getBoundingClientRect().left).toBeGreaterThanOrEqual(edge + 16);
    });
    // Pointed at, the pill comes out around the chevron that opens the space's details.
    await over(q('factory-pill-rail')!, 'mouseover');
    await until(() =>
      expect(Math.round(edge - shape('pill')!.getBoundingClientRect().left)).toBe(40)
    );
    const pill = shape('pill')!.getBoundingClientRect();
    const toggle = q('dock-toggle')!.getBoundingClientRect();
    expect(toggle.top).toBeGreaterThanOrEqual(pill.top);
    expect(toggle.bottom).toBeLessThanOrEqual(pill.bottom);
    await click(q('dock-toggle')!);
    expect(stage.dataset.open).toBe('true');
  });

  it('a view with no schedule has no unit: the pill shows loops', async () => {
    await show();
    expect(q('factory-pill-unit')).toBeNull();
  });

  it('a scheduled view idles as an LED grid, and says when it runs when pointed at', async () => {
    const { onOpenView } = await show([view({ every: '1h', everyMs: H })]);
    const unit = q('factory-pill-unit')!;
    expect(unit.dataset.state).toBe('standby');
    expect(unit.getAttribute('aria-label')).toBe(
      'Bug fixes · Every hour, while Rig is open. Open Bug fixes.'
    );
    await over(unit, 'mouseover');
    await until(() => expect(q('factory-pill-label')?.dataset.open).toBe('true'));
    expect(q('factory-pill-label')!.textContent).toBe('Bug fixesEvery hour, while Rig is open');
    // The label is a shape of the same goo layer, hanging from a neck on the pill.
    expect(shape('label')).not.toBeNull();
    expect(shape('label-neck')).not.toBeNull();
    await click(unit);
    expect(onOpenView).toHaveBeenCalledWith('bugs');
    await over(unit, 'mouseout');
    await until(() => expect(q('factory-pill-label')).toBeNull());
  });

  it('a running pass shows on its view, from the runtime state', async () => {
    const state: SpaceState = {
      bindingId: 'b1',
      at: NOW,
      views: [],
      runs: [
        {
          runId: 'r1',
          startedBy: 'view',
          view: 'bugs',
          ownerUserId: SELF,
          agent: 'claude',
          startedAt: NOW,
          state: 'working',
          step: 'Reading FACTORY.md',
          stepKind: 'reading',
          lastEventAt: NOW,
          endedAt: null,
        },
      ],
    };
    mocks.spaceState = state;
    await show();
    await until(() => expect(q('factory-pill-unit')?.dataset.state).toBe('reading'));
    expect(q('factory-pill-unit')!.getAttribute('aria-label')).toContain('Reading FACTORY.md');
  });

  it("a topic's name comes out as a label, and the transcript is told what it holds", async () => {
    const { onPreview } = await show();
    const topic = q('factory-pill-topic')!;
    await over(topic, 'mouseover');
    await until(() => expect(q('factory-pill-label')?.dataset.open).toBe('true'));
    expect(q('factory-pill-label')!.textContent).toBe('Pricing2 messages');
    expect([...(onPreview.mock.lastCall?.[0] ?? [])]).toEqual(['m1', 'm2']);
    // A press filters to it; another lets go.
    await click(topic);
    expect(topic.getAttribute('aria-pressed')).toBe('true');
    await click(topic);
    expect(topic.getAttribute('aria-pressed')).toBe('false');
  });

  it('the chevron opens the panel out of the pill itself, and the corner chevron folds it back', async () => {
    await show();
    const closed = shape('pill')!.getBoundingClientRect();
    await click(q('dock-toggle')!);
    expect(q('factory-pill')!.dataset.open).toBe('true');
    await until(() => expect(q('card-body')).not.toBeNull());
    // The pill's own shape is now the panel's: as wide as its content, from the same edge.
    const stage = q('factory-pill')!.getBoundingClientRect();
    await until(() => {
      const pill = shape('pill')!.getBoundingClientRect();
      expect(Math.round(stage.right - pill.left)).toBe(304);
      expect(pill.height).toBeGreaterThan(closed.height);
    });
    expect(host!.querySelectorAll('[data-shape="pill"]')).toHaveLength(1);
    // The pill's own units are out of reach while it is the panel.
    expect(q('factory-pill-rail')!.hasAttribute('inert')).toBe(true);
    const fold = [...host!.querySelectorAll<HTMLElement>('[data-testid="dock-toggle"]')].find(
      (el) => el.getAttribute('aria-expanded') === 'true'
    )!;
    await click(fold);
    expect(q('factory-pill')!.dataset.open).toBe('false');
    await until(() => expect(q('card-body')).toBeNull());
    await until(() =>
      expect(Math.round(stage.right - shape('pill')!.getBoundingClientRect().left)).toBe(40)
    );
    expect(q('factory-pill-rail')!.hasAttribute('inert')).toBe(false);
  });
});
