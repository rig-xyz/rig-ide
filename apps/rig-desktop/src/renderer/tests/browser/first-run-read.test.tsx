import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';

/**
 * The first run's Read step on a recorded run: lines come in "Checking…",
 * settle to what was found, the counters follow, and "See the first one"
 * shows once a card is on the Feed, while reading goes on.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { rig: { orch: { firstRun: async () => ({ success: true, data: { started: true } }) } } },
  events: { on: vi.fn(() => () => {}) },
}));

import { ReadStep, type ReadSummary } from '@renderer/features/first-run/read/read-step';
import { replaySource } from '@renderer/features/first-run/read/progress-source';
import recorded from '@renderer/features/first-run/read/fixtures/first-run.json';

const run = 'run_t';
const events: OrchProgressEvent[] = [
  { run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, t: 0 },
  { run, kind: 'line', line: { id: 'step:state', connector: null, label: 'Looking up what Rig already knows', status: 'running', t: 0 } },
  { run, kind: 'pass', pass: 1, lookups: 12, goal: 'first card', lookbackDays: 3, t: 10 },
  { run, kind: 'line', line: { id: 't1', connector: 'slack', label: 'Reading #eng', status: 'running', t: 20 } },
  { run, kind: 'line', line: { id: 't1', connector: 'slack', label: 'Reading #eng', status: 'done', t: 60 } },
  { run, kind: 'line', line: { id: 'outcome:n1', connector: 'linear', label: 'LAR-91: High, unassigned, nobody on it', status: 'for_you', ref: 'sit_9', t: 80 } },
  { run, kind: 'card', ref: 'sit_9', t: 90 },
];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'height:600px;width:370px;display:flex;flex-direction:column';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const counters = () => [...host.querySelectorAll('[aria-label="So far"] b')].map((b) => b.textContent);

describe('ReadStep', () => {
  it('shows each line checking, then what it found, and offers the first card', async () => {
    const done: ReadSummary[] = [];
    const seen: string[] = [];
    await act(async () => {
      root.render(<ReadStep onDone={(s) => done.push(s)} source={replaySource(events)} onProgress={(e) => seen.push(e.kind)} />);
    });
    // The first line shows at once.
    await vi.waitFor(() => expect(host.querySelector('[data-testid="read-ticker"] li')).not.toBeNull());
    const items = () => [...host.querySelectorAll('[data-testid="read-ticker"] li')];
    // The outcome comes in "Checking…" first, then says what it found.
    await vi.waitFor(() => expect(items().some((li) => li.textContent?.startsWith('Checking…'))).toBe(true));
    await vi.waitFor(() => expect(items().find((li) => li.textContent?.includes('LAR-91'))?.textContent).toContain('For you'), { timeout: 2000 });
    expect(counters()).toEqual(['1', '0', '1']);
    expect(seen).toContain('card');
    const see = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('See the first one'));
    expect(see).toBeTruthy();
    await act(async () => see!.click());
    expect(done[0]).toMatchObject({ cards: ['sit_9'], ended: false });
  });

  it('plays the recorded first run back', async () => {
    const fixture = recorded as OrchProgressEvent[];
    await act(async () => {
      root.render(<ReadStep onDone={() => {}} source={replaySource(fixture, { speed: 200 })} />);
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="read-hint"]')!.textContent).toMatch(/first one is ready|Nothing needs you/), { timeout: 5000 });
    expect(Number(counters()[0])).toBeGreaterThan(0);
  });
});
