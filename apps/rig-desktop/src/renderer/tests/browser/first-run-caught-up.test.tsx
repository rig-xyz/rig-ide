import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';

/**
 * All caught up rolls straight into the first card: once the check has
 * landed and its words have risen, it steps aside and First win comes in,
 * with no click. With nothing new to show it waits, with Open my Home.
 */

vi.mock('@renderer/lib/ipc', () => ({ rpc: {}, events: { on: () => () => {} } }));

import type { FirstRunEnv } from '@renderer/features/first-run/env';
import { replaySource } from '@renderer/features/first-run/read/progress-source';
import { CAUGHT_UP_HOLD_MS, CAUGHT_UP_LEAVE_MS, ReadStepView } from '@renderer/features/first-run/read-step-view';
import type { AgentFieldHandle } from '@renderer/lib/ui/agent-field';

const run = 'run_c';
const ending = (withCard: boolean): OrchProgressEvent[] => [
  { run, kind: 'start', trigger: 'first', passes: 1, lookups: 12, lookbackDays: 3, t: 0 },
  { run, kind: 'line', line: { id: 'a', connector: 'slack', label: 'Searching Slack', status: 'done', t: 5 } },
  ...(withCard ? [{ run, kind: 'card', ref: 'sit_peter', fresh: true, t: 8 } as OrchProgressEvent] : []),
  { run, kind: 'end', ok: true, t: 10 },
];

function env(events: OrchProgressEvent[]): FirstRunEnv {
  return {
    rig: { kind: 'signedIn', email: null, name: null, unverified: false },
    rigSignIn: { phase: 'idle', url: null, error: null },
    agent: { kind: 'ready', account: null },
    agentInfo: { name: 'Claude Code', icon: null, route: { connectorsHome: 'claude.ai' } },
    readSource: replaySource(events),
    ensureHome: () => {},
    saveProgress: () => {},
    recheck: () => {},
  } as unknown as FirstRunEnv;
}

const tile = () => ({ set: () => {}, release: () => {} });
const field = createRef<AgentFieldHandle>() as { current: AgentFieldHandle | null };
field.current = { tile, gather: () => {} } as unknown as AgentFieldHandle;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'display:grid;grid-template-columns:370px 1fr;height:700px;width:1100px';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (events: OrchProgressEvent[], onNext: () => void) => {
  await act(async () => {
    root.render(
      <ReadStepView
        env={env(events)}
        plan={null}
        position={null}
        onNext={onNext}
        advancing={false}
        setFieldLook={() => {}}
        field={field}
      />
    );
  });
};
// The check's stroke, the words rising, the hold, and the step aside.
const ROLL_MS = 1500 + 8 * 55 + 900 + CAUGHT_UP_HOLD_MS + CAUGHT_UP_LEAVE_MS;

describe('All caught up', () => {
  it('rolls into the first card on its own, no click', async () => {
    const onNext = vi.fn();
    await render(ending(true), onNext);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="read-caught-up"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="read-to-card"]')!.textContent).toContain('Bringing in your first card');
    // Not before the words have had their moment.
    await new Promise((resolve) => setTimeout(resolve, ROLL_MS - 1200));
    expect(onNext).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="read-caught-up"][data-leaving]')).not.toBeNull(), { timeout: 2000 });
    await vi.waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: 2000 });
  }, 15_000);

  it('a click goes there at once', async () => {
    const onNext = vi.fn();
    await render(ending(true), onNext);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="read-to-card"]')).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="read-to-card"]')!.click());
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('with nothing new it stays, and offers Open my Home', async () => {
    const onNext = vi.fn();
    await render(ending(false), onNext);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="read-caught-up"]')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, ROLL_MS + 500));
    expect(onNext).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="read-caught-up"]')!.textContent).toContain('Open my Home');
  }, 15_000);
});
