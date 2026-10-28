import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Onboarding's First win on the made-up cards: the first card is a Feed row
 * with its answer drafted inline, the carousel swaps the answer, Send turns
 * it into a done card and brings the next one forward, ▾ Show me another
 * flips the front card, and Open my Home ends the step.
 */

vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal: vi.fn() } }, events: { on: () => () => {} } }));

import { ok } from '@emdash/shared';
import type { FirstRunEnv } from '@renderer/features/first-run/env';
import { FirstWinStep, WIN_HOLD_MS } from '@renderer/features/first-run/first-win/first-win-step';
import { simulatedFirstWin } from '@renderer/features/first-run/first-win/fixtures';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
let next: ReturnType<typeof vi.fn<() => void>>;
let sent: string[];
let opened: [string, string][];
beforeEach(async () => {
  host = document.createElement('div');
  host.style.cssText = 'height:800px;width:1100px;display:grid;grid-template-columns:370px 1fr';
  document.body.appendChild(host);
  root = createRoot(host);
  next = vi.fn<() => void>();
  sent = [];
  opened = [];
  const firstWin = simulatedFirstWin((ms, fn) => setTimeout(fn, 20));
  const env = {
    firstWin: {
      ...firstWin,
      send: (item, choice, text) => {
        sent.push(text);
        return firstWin.send(item, choice, text);
      },
      // A real start says which session it started, and in which space's folder.
      start: () => Promise.resolve(ok({ said: 'Started in #home', link: null, session: { root: '/Rig/home', sessionId: 'ses_started' } })),
    },
  } as Partial<FirstRunEnv> as FirstRunEnv;
  await act(async () => {
    root.render(
      <FirstWinStep
        env={env}
        plan={null}
        position="Step 4 of 5"
        onNext={next}
        advancing={false}
        setFieldLook={() => {}}
        field={{ current: null }}
        openSession={(root, sessionId) => opened.push([root, sessionId])}
      />
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const button = (scope: ParentNode, name: RegExp) => [...scope.querySelectorAll('button')].find((b) => name.test(b.textContent ?? '') || name.test(b.getAttribute('aria-label') ?? ''));
async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
}

describe('First win', () => {
  it('shows the first card with its drafted answer, sends it, and that win ends the first run on Home', async () => {
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    expect(host.textContent).toContain('Your first card is ready.');
    // Its amber edge and tint follow the card's rounded corners, not square ones poking out.
    const row = q('.fw-front > [data-feed-id]')!;
    expect(getComputedStyle(row).borderTopLeftRadius).toBe(getComputedStyle(row.parentElement!).borderTopLeftRadius);
    expect(getComputedStyle(row).borderTopLeftRadius).not.toBe('0px');
    expect(q('[data-feed-draft]')!.textContent).toContain('Yes, I’ll be there.');
    expect(q('[data-testid="first-win-more"]')!.textContent).toContain('2 more ready');
    await click(button(q('[data-feed-id="sim:reply"]')!, /Next option/));
    expect(q('[data-feed-draft]')!.textContent).toContain('Thursday’s tight for me.');
    await click(button(q('[data-feed-id="sim:reply"]')!, /^Send/));
    await vi.waitFor(() => expect(q('[data-feed-sent]')).not.toBeNull());
    expect(sent).toEqual(['Thursday’s tight for me. Does Friday morning work? Happy to go through the numbers async before.']);
    expect(q('[data-feed-sent]')!.textContent).toContain('Sent in #product.');
    expect(host.textContent).toContain('Done. One click.');
    // No next card comes forward: the win holds a moment, then Home.
    expect(q('[data-feed-id="sim:review"]')).toBeNull();
    expect(next).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1), { timeout: WIN_HOLD_MS + 1000 });
  });

  it('Open my Home still ends it at once', async () => {
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    await click(button(host, /Open my Home/));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('▾ Show me another flips to the next card', async () => {
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    await click(button(q('[data-feed-id="sim:reply"]')!, /More/));
    await click(button(host, /Show me another/));
    expect(q('[data-feed-id="sim:review"]')).not.toBeNull();
    expect(host.textContent).toContain('Here’s another card.');
    expect(button(q('[data-feed-id="sim:review"]')!, /^Post/)).toBeTruthy();
  });

  it('Start session leaves a done card whose Open goes to the session it started, in its space', async () => {
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    for (const id of ['sim:reply', 'sim:review']) {
      await click(button(q(`[data-feed-id="${id}"]`)!, /More/));
      await click(button(host, /Show me another/));
    }
    await vi.waitFor(() => expect(q('[data-feed-id="sim:fix"]')).not.toBeNull());
    await click(button(q('[data-feed-id="sim:fix"]')!, /Start/));
    await vi.waitFor(() => expect(q('[data-feed-sent]')?.textContent).toContain('Started in #home'));
    await click(button(q('[data-feed-sent]')!, /Open/));
    expect(opened).toEqual([['/Rig/home', 'ses_started']]);
  });

  it('a started card is the win too: a moment, then Home', async () => {
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    for (const id of ['sim:reply', 'sim:review']) {
      await click(button(q(`[data-feed-id="${id}"]`)!, /More/));
      await click(button(host, /Show me another/));
    }
    await vi.waitFor(() => expect(q('[data-feed-id="sim:fix"]')).not.toBeNull());
    await click(button(q('[data-feed-id="sim:fix"]')!, /Start/));
    await vi.waitFor(() => expect(q('[data-feed-sent]')).not.toBeNull());
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1), { timeout: WIN_HOLD_MS + 1000 });
  });
});
