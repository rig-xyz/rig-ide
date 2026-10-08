import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The empty Room's buttons: Ask names the agent you actually have on this
 * Mac, or offers to set one up; Invite asks that agent, or opens the invite
 * form when there's none. The form opens through the top bar's Invite pill.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { agents: { list: async () => [] } },
  events: { on: () => () => {} },
}));

import { RoomWelcome } from '@renderer/features/spaces/components/room-view';
import { OPEN_INVITE_EVENT } from '@renderer/features/rig-share/open-invite';
import { openInviteForm } from '@renderer/features/rig-share/open-invite';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('RoomWelcome', () => {
  let host: HTMLDivElement;
  let root: Root;
  let prefills: string[];
  let invites: number;
  let setUps: number;

  beforeEach(() => {
    prefills = [];
    invites = 0;
    setUps = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(agent: 'claude' | 'codex' | null) {
    await act(async () => {
      root.render(
        <RoomWelcome
          spaceName="#growth"
          connecting={false}
          hasSkills={false}
          agent={agent}
          onPrefill={(text) => prefills.push(text)}
          onInvite={() => invites++}
          onSetUpAgent={() => setUps++}
        />
      );
    });
  }
  const click = (testId: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());

  it('with only Codex, Ask and Invite prefill @codex', async () => {
    await render('codex');
    expect(host.querySelector('[data-testid="room-welcome-ask"]')?.textContent).toBe('Ask @codex');
    await click('room-welcome-ask');
    await click('room-welcome-invite');
    expect(prefills).toEqual(['@codex ', '@codex invite ']);
    expect(invites).toBe(0);
  });

  it('with no agent, nothing is prefilled: Set up an agent, and Invite opens the form', async () => {
    await render(null);
    expect(host.querySelector('[data-testid="room-welcome-ask"]')).toBeNull();
    await click('room-welcome-set-up');
    await click('room-welcome-invite');
    expect(prefills).toEqual([]);
    expect(setUps).toBe(1);
    expect(invites).toBe(1);
  });

  it('openInviteForm reaches whoever listens for the invite form', () => {
    const heard = vi.fn();
    window.addEventListener(OPEN_INVITE_EVENT, heard);
    openInviteForm();
    window.removeEventListener(OPEN_INVITE_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
