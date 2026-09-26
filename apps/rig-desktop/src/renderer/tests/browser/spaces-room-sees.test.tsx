import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentConfigRow,
  AgentSettingsContext,
  type AgentSettingsApi,
} from '@renderer/features/spaces/components/agent-settings';
import { SessionCard } from '@renderer/features/spaces/components/session-card';
import type { RoomMember, SessionEvent, SessionRunMeta } from '@renderer/features/spaces/types';
import { ROOM_SEES_TOOLTIP, type RoomSees } from '@shared/spaces/room-sees';
import '@renderer/tokens.css';

// SafeMarkdown (the answer) imports the IPC bridge; nothing here opens a link.
vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal: async () => {} } } }));

/**
 * "Room sees": the setting's row in your agent's card, and what the Room
 * shows of a run at each level: to its owner, and to everyone else.
 */

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

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

describe('Room sees — the setting in your agent card', () => {
  it('shows only the current pick with the one tooltip, slides the others out on hover, and saves a pick', async () => {
    let level: RoomSees = 'steps';
    const changes: RoomSees[] = [];
    const api: AgentSettingsApi = {
      load: async () => ({ model: null, effort: null, mode: null }),
      change: async () => ({ model: null, effort: null, mode: null }),
      roomSees: {
        load: async () => level,
        change: async (next) => {
          changes.push(next);
          level = next;
          return true;
        },
      },
    };
    await act(async () => {
      root.render(
        <AgentSettingsContext.Provider value={api}>
          <AgentConfigRow agent="claude" avatar={null} busy={null} lastModel={null} usage={null} />
        </AgentSettingsContext.Provider>
      );
    });
    await act(async () => click(host.querySelector('[data-testid="space-agent-row"]')!));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="agent-room-sees"]')).not.toBeNull());

    const row = host.querySelector('[data-testid="agent-room-sees"]')!;
    expect(row.textContent).toContain('Room sees');
    const group = row.querySelector('[data-testid="agent-choices-roomSees"]')!;
    const chips = [...group.querySelectorAll('button')];
    // The current pick first, then the others, folded away until hover or focus.
    expect(chips.map((b) => b.textContent)).toEqual(['Steps', 'Answer', 'Everything']);
    expect(chips[0]!.getAttribute('aria-checked')).toBe('true');
    expect(chips[0]!.title).toBe(ROOM_SEES_TOOLTIP);
    expect(group.getAttribute('data-revealed')).toBe('false');
    expect(row.textContent).not.toContain('what your tools returned'); // no description text, only the tooltip

    await act(async () => group.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => (group as HTMLElement).focus?.());
    await act(async () => chips[1]!.focus());
    expect(group.getAttribute('data-revealed')).toBe('true');
    await act(async () => click(chips[1]!));
    expect(changes).toEqual(['answer']);
    await vi.waitFor(() =>
      expect(
        [...row.querySelectorAll('[data-testid="agent-choices-roomSees"] button')].find(
          (b) => b.getAttribute('aria-checked') === 'true'
        )?.textContent
      ).toBe('Answer')
    );
  });

  it('is absent where the Room has no setting to offer (the scripted demo)', async () => {
    const api: AgentSettingsApi = {
      load: async () => ({ model: null, effort: null, mode: null }),
      change: async () => ({ model: null, effort: null, mode: null }),
    };
    await act(async () => {
      root.render(
        <AgentSettingsContext.Provider value={api}>
          <AgentConfigRow agent="claude" avatar={null} busy={null} lastModel={null} usage={null} />
        </AgentSettingsContext.Provider>
      );
    });
    await act(async () => click(host.querySelector('[data-testid="space-agent-row"]')!));
    expect(host.querySelector('[data-testid="agent-room-sees"]')).toBeNull();
  });
});

const alice: RoomMember = { id: 'alice', name: 'Alice', email: 'alice@example.com', role: 'owner', initial: 'A', status: 'here' };
const start = new Date(Date.now() - 6000).toISOString();
const meta = (status: SessionRunMeta['status']): SessionRunMeta => ({
  id: 'run-1',
  agent: 'claude',
  owner: 'alice',
  model: 'opus',
  title: '',
  status,
  startedAt: start,
  endedAt: status === 'running' ? null : new Date().toISOString(),
});
const answer: SessionEvent = {
  seq: 20,
  kind: 'agent_message_chunk',
  payload: { messageId: 'm', content: { type: 'text', text: 'The board approved the launch.' } },
};
const ended: SessionEvent = { seq: 21, kind: 'turn_ended', payload: { status: 'done' } };

/** A run at Steps, as the relay holds it. */
const STEPS_RUN: SessionEvent[] = [
  { seq: 1, kind: 'run_privacy', payload: { level: 'steps' } },
  { seq: 2, kind: 'tool_call', payload: { toolCallId: 'g1', kind: 'other', status: 'completed', title: 'mcp__granola__list_meetings', private: true } },
  { seq: 3, kind: 'tool_call', payload: { toolCallId: 'r1', kind: 'read', status: 'completed', title: 'Read a file', private: true } },
  { seq: 4, kind: 'tool_call', payload: { toolCallId: 'r2', kind: 'read', status: 'completed', title: 'Read notes/pricing.md', locations: [{ path: 'notes/pricing.md' }] } },
  answer,
  ended,
];

describe('Room sees — what the Room shows', () => {
  it('at Steps: every step by its label, a lock and "private" on what a connector returned or a file outside the space', async () => {
    await act(async () => {
      root.render(<SessionCard meta={meta('done')} events={STEPS_RUN} owner={alice} viewerIsOwner={false} />);
    });
    await act(async () => click(host.querySelector('[data-testid="session-summary"]')!));
    const steps = [...host.querySelectorAll('[data-testid="session-step"]')];
    expect(steps.map((li) => li.textContent)).toEqual([
      // The connector's logo, then its label, then the private mark.
      expect.stringMatching(/Granola · list meetings·private$/),
      'Read a file·private',
      'Read notes/pricing.md',
    ]);
    expect(steps.map((li) => li.querySelector('[data-testid="session-private"]') !== null)).toEqual([true, true, false]);
    expect(host.querySelectorAll('[data-testid="session-step"] svg.lucide-lock')).toHaveLength(2);
    // The private read isn't offered as a source; the space file is.
    expect(host.querySelector('[data-testid="session-sources"]')?.textContent).toContain('pricing.md');
    expect(host.querySelector('[data-testid="session-sources"]')?.textContent).not.toContain('a file');
    expect(host.textContent).toContain('The board approved the launch.');
  });

  it('at Answer: others see "Worked Ns · N steps · private" and the answer, nothing to expand', async () => {
    const events: SessionEvent[] = [
      { seq: 1, kind: 'run_privacy', payload: { level: 'answer' } },
      { seq: 2, kind: 'private_progress', payload: { steps: 1 } },
      { seq: 3, kind: 'private_progress', payload: { steps: 4 } },
      answer,
      { seq: 22, kind: 'private_progress', payload: { steps: 4, final: true } },
      ended,
    ];
    await act(async () => {
      root.render(<SessionCard meta={meta('done')} events={events} owner={alice} viewerIsOwner={false} />);
    });
    const summary = host.querySelector('[data-testid="session-summary"]')!;
    expect(summary.tagName).toBe('DIV');
    expect(summary.textContent).toMatch(/^Worked \d+s · 4 steps·private$/);
    expect(summary.querySelector('svg.lucide-lock')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-open-trace"]')).toBeNull();
    expect(host.textContent).toContain('The board approved the launch.');
  });

  it('at Answer, while running: "Working · N steps", no step list or plan', async () => {
    const events: SessionEvent[] = [
      { seq: 1, kind: 'run_privacy', payload: { level: 'answer' } },
      { seq: 2, kind: 'private_progress', payload: { steps: 2 } },
    ];
    await act(async () => {
      root.render(<SessionCard meta={meta('running')} events={events} owner={alice} viewerIsOwner={false} />);
    });
    expect(host.querySelector('[data-testid="session-live-line"]')?.textContent).toContain('Working · 2 steps');
    expect(host.querySelector('[data-testid="session-live-line"] svg.lucide-lock')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-steps"]')).toBeNull();
  });

  it('the owner always sees all of their own work, whatever the level', async () => {
    const own: SessionEvent[] = [
      { seq: 1, kind: 'run_privacy', payload: { level: 'answer' } },
      { seq: 2, kind: 'agent_thought_chunk', payload: { content: { type: 'text', text: 'Check the board notes' } } },
      { seq: 3, kind: 'tool_call', payload: { toolCallId: 'g1', kind: 'other', status: 'completed', title: 'mcp__granola__list_meetings' } },
      answer,
      ended,
    ];
    await act(async () => {
      root.render(<SessionCard meta={meta('done')} events={own} owner={alice} viewerIsOwner />);
    });
    await act(async () => click(host.querySelector('[data-testid="session-summary"]')!));
    expect(host.querySelector('[data-testid="session-thinking"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-step"]')?.textContent).toMatch(/Granola · list meetings$/);
    expect(host.querySelector('[data-testid="session-private"]')).toBeNull();
  });
});

describe('Room sees — Hide details', () => {
  const ownFull: SessionEvent[] = [
    { seq: 1, kind: 'run_privacy', payload: { level: 'steps' } },
    { seq: 2, kind: 'tool_call', payload: { toolCallId: 'g1', kind: 'other', status: 'completed', title: 'mcp__granola__list_meetings' } },
    { seq: 3, kind: 'tool_call', payload: { toolCallId: 'r2', kind: 'read', status: 'completed', title: 'Read notes/pricing.md' } },
    answer,
    ended,
  ];

  it('is offered on your own finished turn (EyeOff), and hides it', async () => {
    const onHideDetails = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root.render(<SessionCard meta={meta('done')} events={ownFull} owner={alice} viewerIsOwner onHideDetails={onHideDetails} />);
    });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="session-hide-details"]')!;
    expect(button.getAttribute('aria-label')).toBe('Hide details');
    expect(button.querySelector('svg.lucide-eye-off')).not.toBeNull();
    await act(async () => click(button));
    expect(onHideDetails).toHaveBeenCalledTimes(1);
  });

  it('is not offered while running, on a run already at Answer, or once hidden', async () => {
    const onHideDetails = vi.fn().mockResolvedValue(true);
    const cases: Array<[SessionRunMeta, SessionEvent[]]> = [
      [meta('running'), ownFull.slice(0, 3)],
      [meta('done'), [{ seq: 1, kind: 'run_privacy', payload: { level: 'answer' } }, answer, ended]],
      [meta('done'), [...ownFull, { seq: 30, kind: 'details_hidden', payload: { steps: 2 } }]],
    ];
    for (const [m, events] of cases) {
      await act(async () => {
        root.render(<SessionCard meta={m} events={events} owner={alice} viewerIsOwner onHideDetails={onHideDetails} />);
      });
      expect(host.querySelector('[data-testid="session-hide-details"]')).toBeNull();
    }
  });

  it('after the fact: others drop to the answer; the owner keeps everything, marked "details hidden"', async () => {
    const hidden: SessionEvent[] = [...ownFull, { seq: 30, kind: 'details_hidden', payload: { steps: 2 } }];
    await act(async () => {
      root.render(<SessionCard meta={meta('done')} events={hidden} owner={alice} viewerIsOwner={false} />);
    });
    // Only the count: not even "read 1 file" from steps this viewer fetched before they were hidden.
    expect(host.querySelector('[data-testid="session-summary"]')?.textContent).toMatch(/^Worked \d+s · 2 steps·private$/);
    expect(host.querySelector('[data-testid="session-steps"]')).toBeNull();

    await act(async () => {
      root.render(<SessionCard meta={meta('done')} events={hidden} owner={alice} viewerIsOwner />);
    });
    const summary = host.querySelector('[data-testid="session-summary"]')!;
    expect(summary.textContent).toContain('details hidden');
    expect(summary.querySelector('svg.lucide-eye-off')).not.toBeNull();
    await act(async () => click(summary));
    expect(host.querySelectorAll('[data-testid="session-step"]')).toHaveLength(2);
  });
});
