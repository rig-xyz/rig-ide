import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomMember, RoomSnapshot, SessionEvent, SessionRunMeta } from '@renderer/features/spaces/types';
// Real tokens — `SpaceRail`'s tiles read live CSS custom properties.
import '@renderer/tokens.css';

/**
 * Doc-focus round: `SpaceRail` replaces the old floating bottom-right chip
 * (`RoomView`'s own `collapsed` prop) with a slim left rail — see that
 * component's own header comment. Covers: the rail itself (agent tiles +
 * Back to Room + faces) and `RoomView`'s collapsed integration (the rail
 * shows, the old chip testid is gone).
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    rig: { spacesConnection: { getConnectionInfo: async () => ({ success: false, error: { message: 'offline' } }) } },
  },
}));

import { RoomView } from '@renderer/features/spaces/components/room-view';
import { SpaceRail } from '@renderer/features/spaces/components/space-rail';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function member(id: string, name: string, online = true): RoomMember {
  return { id, name, email: `${id}@acme.com`, role: 'member', initial: name[0]!, status: 'here', online } as RoomMember;
}

function run(id: string, owner: string, agent: 'claude' | 'codex', status: SessionRunMeta['status'] = 'running'): SessionRunMeta {
  return { id, agent, owner, model: '', title: '', status, startedAt: new Date().toISOString(), endedAt: null } as unknown as SessionRunMeta;
}

const chunk: SessionEvent = { seq: 1, kind: 'agent_message_chunk', payload: { messageId: 'x', content: { type: 'text', text: 'Working' } } };
const asking: SessionEvent = {
  seq: 2,
  kind: 'permission_requested',
  payload: { requestId: 'r1', toolCall: { toolCallId: 't1', title: 'Linear · create issue' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] },
};

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    name: 'growth',
    ready: true,
    members: [member('dylan', 'Dylan'), member('sam', 'Sam')],
    agents: [
      { agent: 'claude', owner: 'dylan', model: 'claude', busy: false },
      { agent: 'codex', owner: 'sam', model: 'codex', busy: false },
    ],
    connectors: [],
    skills: [],
    messages: [],
    invitesById: {},
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    typingUserIds: [],
    connection: 'online',
    ...overrides,
  };
}

describe('SpaceRail', () => {
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

  it('renders one tile per agent in the space, faces, and a Back to Room control', async () => {
    await act(async () => {
      root.render(<SpaceRail snapshot={snapshot()} onExpand={() => {}} />);
    });

    expect(host.querySelector('[data-testid="space-rail"]')).not.toBeNull();
    const tiles = host.querySelectorAll('[data-testid="space-rail-agent-tile"]');
    expect(tiles.length).toBe(2); // dylan's claude, sam's codex

    const faces = host.querySelectorAll('[data-testid="space-rail-person"]');
    expect(faces.length).toBe(2); // dylan, sam

    const back = host.querySelector<HTMLButtonElement>('[data-testid="space-rail-back"]');
    expect(back).not.toBeNull();
    expect(back?.getAttribute('aria-label')).toBe('Back to the Room');
  });

  it('brings the Room back on "Back to Room"', async () => {
    let expanded = 0;
    await act(async () => {
      root.render(<SpaceRail snapshot={snapshot()} onExpand={() => expanded++} />);
    });
    const back = host.querySelector<HTMLButtonElement>('[data-testid="space-rail-back"]')!;
    await act(async () => {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(expanded).toBe(1);
  });

  it('a working agent gets a live tile; one waiting on you breathes', async () => {
    const s = snapshot({
      sessionMetaByRun: { a: run('a', 'dylan', 'claude'), b: run('b', 'sam', 'codex') },
      sessionEventsByRun: { a: [chunk], b: [chunk, asking] },
    });
    await act(async () => {
      root.render(<SpaceRail snapshot={s} onExpand={() => {}} />);
    });
    const tiles = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="space-rail-agent-tile"]'));
    expect(tiles.some((t) => t.dataset.kind === 'live')).toBe(true);
    // The one waiting on Sam's own approval breathes ("waiting").
    expect(host.querySelector('[data-state="waiting"]')).not.toBeNull();
  });

  it('a quiet agent (no runs) gets the still, dim tile', async () => {
    await act(async () => {
      root.render(<SpaceRail snapshot={snapshot()} onExpand={() => {}} />);
    });
    const tiles = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="space-rail-agent-tile"]'));
    expect(tiles.every((t) => t.dataset.kind === 'quiet')).toBe(true);
  });
});

describe('RoomView — doc-focus collapse', () => {
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

  // Doc-focus round: the old floating bottom-right chip is gone — a
  // collapsed Room now renders the rail (in flow, inside whatever sliver
  // App.tsx gives it) instead of a `position: fixed` overlay. There's no
  // live relay in this test env, so this switches to the scripted demo
  // first (same path `spaces-room.test.tsx`'s own "goes from the connect
  // error..." test uses) to get a real, rendered snapshot before toggling
  // `collapsed`.
  it('shows the rail instead of the old floating chip once collapsed', async () => {
    let expandCount = 0;
    await act(async () => {
      root.render(<RoomView bindingId="b1" spaceName="Room" onExpand={() => expandCount++} />);
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Could not connect'));
    const demo = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('scripted demo'))!;
    await act(async () => {
      demo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="room-view"]')).not.toBeNull());

    // Not collapsed yet: neither the rail nor the retired chip shows.
    expect(host.querySelector('[data-testid="space-rail"]')).toBeNull();
    expect(host.querySelector('[data-testid="room-collapsed-chip"]')).toBeNull();

    await act(async () => {
      root.render(<RoomView bindingId="b1" spaceName="Room" collapsed onExpand={() => expandCount++} />);
    });

    expect(host.querySelector('[data-testid="space-rail"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="room-collapsed-chip"]')).toBeNull();

    const back = host.querySelector<HTMLButtonElement>('[data-testid="space-rail-back"]')!;
    await act(async () => {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(expandCount).toBe(1);
  });
});
