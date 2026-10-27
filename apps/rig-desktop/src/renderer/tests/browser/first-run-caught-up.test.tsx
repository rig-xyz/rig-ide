import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';

/**
 * The Read step's pace: as soon as the first card is ready it moves on to it
 * (First win) after a beat, while the read goes on; All caught up stays on
 * the stage only for a read that ended with no card. Its lit tiles say what
 * they read, a few at a time.
 */

vi.mock('@renderer/lib/ipc', () => ({ rpc: {}, events: { on: () => () => {} } }));

import type { FirstRunEnv } from '@renderer/features/first-run/env';
import { MAX_CAPTIONS } from '@renderer/features/first-run/read/field-captions';
import { replaySource } from '@renderer/features/first-run/read/progress-source';
import { FIRST_CARD_BEAT_MS, ReadStepView } from '@renderer/features/first-run/read-step-view';
import type { AgentFieldHandle } from '@renderer/lib/ui/agent-field';

const run = 'run_c';
const start: OrchProgressEvent = { run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, t: 0 };
const reading = (id: string, label: string, t: number): OrchProgressEvent => ({ run, kind: 'line', line: { id, connector: 'slack', label, status: 'running', t } });

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

// A field whose tiles sit in the middle of the stage.
const tile = () => ({ set: () => {}, release: () => {}, at: () => ({ x: 0.5, y: 0.5 }) });
const field = createRef<AgentFieldHandle>() as { current: AgentFieldHandle | null };
field.current = { tile, gather: () => {} } as unknown as AgentFieldHandle;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'display:grid;grid-template-columns:370px 1fr;height:700px;width:1100px;position:relative';
  // The field's box, which captions are placed over.
  const stage = document.createElement('div');
  stage.className = 'fr-stage';
  stage.style.cssText = 'position:absolute;left:370px;top:0;width:730px;height:700px';
  host.appendChild(stage);
  document.body.appendChild(host);
  root = createRoot(host.appendChild(document.createElement('div')));
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
        openSession={null}
      />
    );
  });
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the Read step', () => {
  it('moves on to the first card after a beat, while the read goes on', async () => {
    const onNext = vi.fn();
    await render([start, reading('a', 'Reading #eng', 5), { run, kind: 'card', ref: 'sit_peter', fresh: true, t: 8 }, reading('b', 'Reading #ops', 30)], onNext);
    await vi.waitFor(() => expect(host.textContent).toContain('See it on your Feed'));
    await wait(FIRST_CARD_BEAT_MS - 500);
    expect(onNext).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: 2000 });
    // No All caught up on the stage: the rest of the read shows on Home.
    expect(host.querySelector('[data-testid="read-caught-up"]')).toBeNull();
  });

  it('a read that ended with a card moves on too, with no All caught up', async () => {
    const onNext = vi.fn();
    await render([start, { run, kind: 'card', ref: 'sit_peter', fresh: true, t: 8 }, { run, kind: 'end', ok: true, t: 10 }], onNext);
    await vi.waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: FIRST_CARD_BEAT_MS + 1500 });
    expect(host.querySelector('[data-testid="read-caught-up"]')).toBeNull();
  });

  it('a read that ended with no card shows All caught up, and stays', async () => {
    const onNext = vi.fn();
    await render([start, reading('a', 'Reading #eng', 5), { run, kind: 'end', ok: true, t: 10 }], onNext);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="read-caught-up"]')).not.toBeNull());
    await wait(FIRST_CARD_BEAT_MS + 500);
    expect(onNext).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="read-caught-up"]')!.textContent).toContain('Open my Home');
    // No captions during the gather.
    expect(host.querySelector('[data-testid="field-captions"]')).toBeNull();
  });

  it('captions a lit tile with what it reads, a few at a time, and lets them go as tiles settle', async () => {
    await render(
      [start, reading('a', 'Reading #eng-standup', 1), reading('b', 'Reading #ops', 2), reading('c', 'Searching Slack for "pilot review"', 3), reading('d', 'Reading #product', 4)],
      () => {}
    );
    await vi.waitFor(() => expect(host.querySelectorAll('[data-caption]:not(.fr-caption-leaving)').length).toBe(MAX_CAPTIONS));
    const shown = [...host.querySelectorAll('[data-caption]:not(.fr-caption-leaving)')].map((c) => c.textContent);
    // The oldest stepped aside for the fourth; each says its channel or what it searches for.
    expect(shown).toEqual(['#ops', 'pilot review', '#product']);
    // Gone once the tiles have settled to grey.
    await vi.waitFor(() => expect(host.querySelectorAll('[data-caption]').length).toBe(0), { timeout: 4000 });
  });
});
