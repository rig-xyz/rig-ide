import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';

/**
 * The first run's Read step on a recorded run: lines come in "Checking…",
 * settle to what was found, the counters follow, and "See it on your Feed"
 * shows once a card is on the Feed, while reading goes on.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { rig: { orch: { firstRun: async () => ({ success: true, data: { started: true } }) } } },
  events: { on: vi.fn(() => () => {}) },
}));

import recorded from '@renderer/features/first-run/read/fixtures/first-run.json';
import { replaySource } from '@renderer/features/first-run/read/progress-source';
import { ReadStep, type ReadFix, type ReadSummary } from '@renderer/features/first-run/read/read-step';

const run = 'run_t';
const events: OrchProgressEvent[] = [
  { run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, t: 0 },
  {
    run,
    kind: 'line',
    line: {
      id: 'step:state',
      connector: null,
      label: 'Looking up what Rig already knows',
      status: 'running',
      t: 0,
    },
  },
  { run, kind: 'pass', pass: 1, lookups: 12, goal: 'first card', lookbackDays: 3, t: 10 },
  {
    run,
    kind: 'line',
    line: { id: 't1', connector: 'slack', label: 'Reading #eng', status: 'running', t: 20 },
  },
  {
    run,
    kind: 'line',
    line: { id: 't1', connector: 'slack', label: 'Reading #eng', status: 'done', t: 60 },
  },
  {
    run,
    kind: 'line',
    line: {
      id: 'outcome:n1',
      connector: 'linear',
      label: 'LAR-91: High, unassigned, nobody on it',
      status: 'for_you',
      ref: 'sit_9',
      t: 80,
    },
  },
  { run, kind: 'card', ref: 'sit_9', t: 90 },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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

// The rolling digits keep the old one for a moment; the label is the number.
const counters = () =>
  [...host.querySelectorAll('[aria-label="So far"] b')].map((b) => b.getAttribute('aria-label'));

describe('ReadStep', () => {
  it('shows each line checking, then what it found, and names the first card while it reads on', async () => {
    const done: ReadSummary[] = [];
    const seen: string[] = [];
    await act(async () => {
      root.render(
        <ReadStep
          onDone={(s) => done.push(s)}
          source={replaySource(events)}
          onProgress={(e) => seen.push(e.kind)}
        />
      );
    });
    // The first line shows at once.
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="read-ticker"] li')).not.toBeNull()
    );
    const items = () => [...host.querySelectorAll('[data-testid="read-ticker"] li')];
    // The outcome comes in "Checking…" first, then says what it found.
    await vi.waitFor(() =>
      expect(items().some((li) => li.textContent?.startsWith('Checking…'))).toBe(true)
    );
    await vi.waitFor(
      () =>
        expect(items().find((li) => li.textContent?.includes('LAR-91'))?.textContent).toContain(
          'For you'
        ),
      { timeout: 2000 }
    );
    expect(counters()).toEqual(['1', '0', '1']);
    expect(seen).toContain('card');
    // The card itself rises on the stage (first-run-one-stage.test.tsx); here the hint names it.
    expect(host.querySelector('[data-testid="read-hint"]')!.textContent).toContain('Rig keeps reading the rest');
    expect(done).toEqual([]);
  });

  it("keeps each line's own connector, and shows a neutral mark when there is none", async () => {
    const mixed: OrchProgressEvent[] = [
      { run, kind: 'start', trigger: 'first', passes: 1, lookups: 12, lookbackDays: 3, t: 0 },
      ...(
        [
          ['l1', 'slack', 'Reading #eng', 'done'],
          ['l2', 'linear', 'Opening LAR-91', 'done'],
          ['l3', 'github', 'Opening #212', 'done'],
          ['outcome:o1', 'gmail', 'AWS invoice: you forwarded it last month', 'handled'],
          ['outcome:o2', null, 'Team offsite poll: Sam is running it', 'not_yours'],
          ['l4', 'notion', 'Opening a Notion page', 'done'],
        ] as const
      ).map(
        ([id, connector, label, status], i): OrchProgressEvent => ({
          run,
          kind: 'line',
          line: { id, connector, label, status, t: 10 + i },
        })
      ),
    ];
    await act(async () => {
      root.render(<ReadStep onDone={() => {}} source={replaySource(mixed)} />);
    });
    const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="read-ticker"] li')];
    await vi.waitFor(() => expect(rows()).toHaveLength(6));
    expect(rows().map((li) => li.dataset.connector)).toEqual([
      'slack',
      'linear',
      'github',
      'gmail',
      'none',
      'notion',
    ]);
    // A logo only for a connector Rig has one for; the rest get the neutral mark, never Slack's.
    const marks = rows().map((li) =>
      li.firstElementChild!.querySelector('svg') ? 'logo' : 'neutral'
    );
    expect(marks).toEqual(['logo', 'logo', 'logo', 'logo', 'neutral', 'neutral']);
    const svgOf = (i: number) => rows()[i]!.firstElementChild!.querySelector('svg')!.innerHTML;
    expect(new Set([0, 1, 2, 3].map(svgOf)).size).toBe(4);
  });

  it("keeps the recorded run's connectors as recorded", () => {
    const fixture = recorded as OrchProgressEvent[];
    const outcomes = fixture.flatMap((e) =>
      e.kind === 'line' && ['handled', 'not_yours', 'for_you'].includes(e.line.status)
        ? [e.line]
        : []
    );
    // Each made-up ref is shaped like its own connector's.
    for (const l of outcomes) {
      if (l.connector === 'slack') expect(l.ref).toMatch(/^msg:slack:/);
      if (l.connector === 'linear') expect(l.ref).toMatch(/^item:LAR-/);
    }
    expect(new Set(outcomes.map((l) => l.connector))).toEqual(new Set(['slack', 'linear']));
  });

  it('plays the recorded first run back', async () => {
    const fixture = recorded as OrchProgressEvent[];
    await act(async () => {
      root.render(<ReadStep onDone={() => {}} source={replaySource(fixture, { speed: 200 })} />);
    });
    await vi.waitFor(
      () =>
        expect(host.querySelector('[data-testid="read-hint"]')!.textContent).toMatch(
          /first card|Nothing needs you/
        ),
      { timeout: 5000 }
    );
    expect(Number(counters()[0])).toBeGreaterThan(0);
  });

  it('catches someone up since their last read, and a card already on the Feed is not new', async () => {
    const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const catchUp: OrchProgressEvent[] = [
      { run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, since, t: 0 },
      {
        run,
        kind: 'line',
        line: { id: 'o1', connector: 'slack', label: 'Priya still waits on you', status: 'for_you', ref: 'sit_old', known: true, t: 10 },
      },
      { run, kind: 'card', ref: 'sit_old', fresh: false, t: 20 },
      { run, kind: 'end', ok: true, t: 30 },
    ];
    await act(async () => {
      root.render(<ReadStep onDone={() => {}} source={replaySource(catchUp)} />);
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="read-hint"]')!.textContent).toContain('first card')
    );
    // Nothing new for the Feed: the one card was there before.
    expect(counters()[2]).toBe('0');
    expect(host.textContent).toContain('new for your Feed');
  });

  it('says the window while it starts', async () => {
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await act(async () => {
      root.render(
        <ReadStep
          onDone={() => {}}
          source={replaySource([{ run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, since, t: 0 }])}
        />
      );
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="read-now"]')!.textContent).toMatch(/^Reading what’s new since your last catch-up on /)
    );
  });

  it('a read that stopped says why and offers its one fix, never a dead end', async () => {
    const fixes: ReadFix[] = [];
    await act(async () => {
      root.render(
        <ReadStep
          onDone={() => {}}
          onFix={(f) => fixes.push(f)}
          source={replaySource([
            { run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, t: 0 },
            { run, kind: 'end', ok: false, error: 'Your Rig session expired.', problem: 'rig_signed_out', t: 5 },
          ])}
        />
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Your Rig sign-in lapsed'));
    const fix = host.querySelector<HTMLButtonElement>('[data-testid="read-fix"]')!;
    expect(fix.textContent).toContain('Sign in again');
    await act(async () => fix.click());
    expect(fixes).toEqual([{ problem: 'rig_signed_out' }]);
    // The Feed is still a way out.
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Open my Feed'))).toBe(true);
  });

  it('a connector that needs reconnecting is said once, with its link, while reading goes on', async () => {
    const fixes: ReadFix[] = [];
    await act(async () => {
      root.render(
        <ReadStep
          onDone={() => {}}
          onFix={(f) => fixes.push(f)}
          source={replaySource([
            { run, kind: 'start', trigger: 'first', passes: 2, lookups: 52, lookbackDays: 3, t: 0 },
            { run, kind: 'problem', problem: 'connector_auth', connector: 'slack', t: 5 },
            { run, kind: 'problem', problem: 'connector_auth', connector: 'slack', t: 6 },
          ])}
        />
      );
    });
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="read-reconnect"]')).toHaveLength(1));
    const row = host.querySelector('[data-testid="read-reconnect"]')!;
    expect(row.textContent).toContain('Slack needs reconnecting');
    await act(async () => row.querySelector('button')!.click());
    expect(fixes).toEqual([{ problem: 'connector_auth', connector: 'slack' }]);
  });
});
