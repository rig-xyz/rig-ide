import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';

/**
 * The first run's one stage: the read's header and counters on the stage,
 * the ticker alone in the guide; the first card rising over the field while
 * it keeps reading, with no step change; the field settling into a breath
 * when the read ends with a card up; All caught up only for a read with no
 * card; captions from what Claude reads and thinks; and a win that ends on
 * Home with the started session to land.
 */

vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal: vi.fn() } }, events: { on: () => () => {} } }));

import { ok } from '@emdash/shared';
import type { FirstRunEnv } from '@renderer/features/first-run/env';
import type { FieldLook } from '@renderer/features/first-run/first-run';
import { WIN_HOLD_MS } from '@renderer/features/first-run/first-win/card-stack';
import { FIRST_WIN_CARDS, simulatedFirstWin } from '@renderer/features/first-run/first-win/fixtures';
import { MAX_CAPTIONS } from '@renderer/features/first-run/read/field-captions';
import { replaySource } from '@renderer/features/first-run/read/progress-source';
import { ReadStepView } from '@renderer/features/first-run/read-step-view';
import { clearHomeArrival, homeArrival } from '@renderer/features/home-feed/arrival';
import type { AgentFieldHandle } from '@renderer/lib/ui/agent-field';

const run = 'run_c';
const start: OrchProgressEvent = { run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, t: 0 };
const reading = (id: string, label: string, t: number): OrchProgressEvent => ({ run, kind: 'line', line: { id, connector: 'slack', label, status: 'running', t } });
const card = (ref: string, t: number): OrchProgressEvent => ({ run, kind: 'card', ref, fresh: true, t });
const end: OrchProgressEvent = { run, kind: 'end', ok: true, t: 90 };

let cardsOnFeed = 1;
function env(events: OrchProgressEvent[]): FirstRunEnv {
  const sim = simulatedFirstWin((_ms, fn) => setTimeout(fn, 20));
  return {
    rig: { kind: 'signedIn', email: null, name: null, unverified: false },
    rigSignIn: { phase: 'idle', url: null, error: null },
    agent: { kind: 'ready', account: null },
    agentInfo: { name: 'Claude Code', icon: null, route: { connectorsHome: 'claude.ai' } },
    readSource: replaySource(events),
    ensureHome: () => {},
    saveProgress: () => {},
    recheck: () => {},
    trackStep: () => {},
    firstWin: {
      ...sim,
      cards: () => Promise.resolve(FIRST_WIN_CARDS.slice(0, cardsOnFeed)),
      start: () => Promise.resolve(ok({ said: 'Started in #home', link: null, session: { root: '/Rig/home', sessionId: 'ses_started' } })),
    },
  } as unknown as FirstRunEnv;
}

// A field whose tiles sit in the middle of the stage, and say when they're let go.
let released: string[] = [];
const tile = (id: string) => ({ set: () => {}, release: () => released.push(id), at: () => ({ x: 0.5, y: 0.5 }) });
const field = createRef<AgentFieldHandle>() as { current: AgentFieldHandle | null };
field.current = { tile, gather: () => {} } as unknown as AgentFieldHandle;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
let looks: FieldLook[];
beforeEach(() => {
  cardsOnFeed = 1;
  released = [];
  looks = [];
  clearHomeArrival();
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

const render = async (events: OrchProgressEvent[], onNext: () => void = () => {}) => {
  await act(async () => {
    root.render(
      <ReadStepView
        env={env(events)}
        plan={null}
        position="Step 3 of 4"
        onNext={onNext}
        advancing={false}
        setFieldLook={(look) => looks.push(look)}
        field={field}
        openSession={null}
      />
    );
  });
};
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shownCaptions = () => [...host.querySelectorAll('[data-caption]:not(.fr-caption-leaving)')].map((c) => c.textContent);

describe('the first run’s one stage', () => {
  it('has the header and counters on the stage, and only the ticker in the guide', async () => {
    await render([start, reading('a', 'Checking #eng-standup', 5)]);
    await vi.waitFor(() => expect(q('[data-testid="read-stage"] [data-testid="read-header"]')).not.toBeNull());
    expect(q('[data-testid="read-header"]')!.textContent).toContain('Catching you up');
    expect(q('[data-testid="read-header"] [aria-label="So far"]')).not.toBeNull();
    // Once: no second header in the guide.
    expect(host.querySelectorAll('[data-testid="read-header"]').length).toBe(1);
    expect(q('aside [data-testid="read-ticker"]')).not.toBeNull();
  });

  it('brings the first card up over the field while it keeps reading: no step change', async () => {
    const onNext = vi.fn();
    await render([start, reading('a', 'Checking #eng', 5), card('sit_peter', 8), reading('b', 'Reading PR #412', 30)], onNext);
    await vi.waitFor(() => expect(q('[data-testid="read-stage"] [data-testid="first-win"] [data-feed-id="sim:reply"]')).not.toBeNull());
    await wait(1800);
    expect(onNext).not.toHaveBeenCalled();
    // Still reading behind it, and saying what.
    expect(q('[data-testid="read-header"]')!.textContent).toContain('Catching you up');
    expect(shownCaptions()).toContain('Reading PR #412');
    expect(q('[data-testid="read-caught-up"]')).toBeNull();
  });

  it('cycles the cards as more land during the read', async () => {
    await render([start, card('sit_a', 5)]);
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    expect(q('[data-testid="first-win-count"]')).toBeNull();
    cardsOnFeed = 3;
    await act(async () => {
      root.render(
        <ReadStepView
          env={env([start, card('sit_a', 5), card('sit_b', 6), card('sit_c', 7)])}
          plan={null}
          position={null}
          onNext={() => {}}
          advancing={false}
          setFieldLook={() => {}}
          field={field}
          openSession={null}
        />
      );
    });
    await vi.waitFor(() => expect(q('[data-testid="first-win-count"]')?.textContent).toBe('1 of 3'));
  });

  it('when the read ends with a card up, the sparks stop and the field settles into a breath, no finale', async () => {
    const onNext = vi.fn();
    await render([start, reading('a', 'Checking #eng', 5), card('sit_peter', 8), end], onNext);
    await vi.waitFor(() => expect(looks).toContain('calm'));
    expect(q('[data-testid="read-header"]')!.textContent).toContain('All caught up');
    expect(q('[data-testid="read-caught-up"]')).toBeNull();
    expect(q('[data-testid="field-captions"]')).toBeNull();
    // Its tiles go back to the grid.
    await vi.waitFor(() => expect(released).toContain('a'), { timeout: 3000 });
    expect(q('[data-feed-id="sim:reply"]')).not.toBeNull();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('a read that ended with no card shows All caught up, and stays', async () => {
    const onNext = vi.fn();
    await render([start, reading('a', 'Checking #eng', 5), end], onNext);
    await vi.waitFor(() => expect(q('[data-testid="read-caught-up"]')).not.toBeNull());
    await wait(1500);
    expect(onNext).not.toHaveBeenCalled();
    expect(q('[data-testid="read-caught-up"]')!.textContent).toContain('Open my Home');
    // No header over it, and no captions during the gather.
    expect(q('[data-testid="read-header"]')).toBeNull();
    expect(q('[data-testid="field-captions"]')).toBeNull();
  });

  it("captions lit tiles with Claude's own lookups and thoughts, a few at a time", async () => {
    await render([
      start,
      reading('a', 'Checking #eng-standup', 1),
      { run, kind: 'thought', text: 'Most of #eng is already resolved', t: 2 },
      reading('b', 'Reading PR #412', 3),
      { run, kind: 'line', line: { id: 'c', connector: 'linear', label: 'Analyzing Linear ENG-311', status: 'running', t: 4 } },
    ]);
    await vi.waitFor(() => expect(shownCaptions().length).toBe(MAX_CAPTIONS));
    // The oldest stepped aside for the newest.
    expect(shownCaptions()).toEqual(['Most of #eng is already resolved', 'Reading PR #412', 'Analyzing Linear ENG-311']);
    expect(q('[data-caption^="thought:"] .fr-caption-think')).not.toBeNull();
    // Gone once the tiles have settled.
    await vi.waitFor(() => expect(host.querySelectorAll('[data-caption]').length).toBe(0), { timeout: 4000 });
  });

  it('a started card is the win: a moment, then Home, with the session to land there', async () => {
    const onNext = vi.fn();
    cardsOnFeed = 3;
    await render([start, card('sit_a', 5)], onNext);
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    await act(async () => q('button[aria-label="The card before"]')!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-feed-id="sim:fix"] button')].find((b) => /Start/.test(b.textContent ?? ''))!.click());
    await vi.waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: WIN_HOLD_MS + 1500 });
    expect(homeArrival()).toEqual({ sessionId: 'ses_started' });
  });
});
