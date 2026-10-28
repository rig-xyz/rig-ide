import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first run's cards on the Read stage, on the made-up cards: the Feed's
 * title row with ‹ 1 of 3 › to cycle them, the card in front as a plain Feed
 * row with its answer drafted inline, Send or Start as the win (a moment,
 * then Home), and cards that land while Rig reads joining the cycle.
 */

vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal: vi.fn() } }, events: { on: () => () => {} } }));

import { ok } from '@emdash/shared';
import type { FirstWinEnv } from '@renderer/features/first-run/env';
import { CardStack, WIN_HOLD_MS } from '@renderer/features/first-run/first-win/card-stack';
import { FIRST_WIN_CARDS, simulatedFirstWin } from '@renderer/features/first-run/first-win/fixtures';
import type { SentResult } from '@renderer/features/home-feed/store';
import '@renderer/features/home-feed/home-feed.css';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
let won: ReturnType<typeof vi.fn<(r: SentResult) => void>>;
let sent: string[];
let opened: [string, string][];
let shownCards: number;
let firstWin: FirstWinEnv;
const mount = async (landed: number) => {
  await act(async () => {
    root.render(
      <CardStack
        firstWin={firstWin}
        landed={landed}
        onWon={won}
        openSession={(root, sessionId) => opened.push([root, sessionId])}
      />
    );
  });
};
beforeEach(async () => {
  host = document.createElement('div');
  host.style.cssText = 'height:800px;width:700px;display:grid;place-items:start center';
  document.body.appendChild(host);
  root = createRoot(host);
  won = vi.fn<(r: SentResult) => void>();
  sent = [];
  opened = [];
  shownCards = FIRST_WIN_CARDS.length;
  const sim = simulatedFirstWin((_ms, fn) => setTimeout(fn, 20));
  firstWin = {
    ...sim,
    // The Feed as it stands: as many cards as have landed so far.
    cards: () => Promise.resolve(FIRST_WIN_CARDS.slice(0, shownCards)),
    send: (item, choice, text) => {
      sent.push(text);
      return sim.send(item, choice, text);
    },
    // A real start says which session it started, and in which space's folder.
    start: () => Promise.resolve(ok({ said: 'Started in #home', link: null, session: { root: '/Rig/home', sessionId: 'ses_started' } })),
  };
  await mount(1);
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
const count = () => q('[data-testid="first-win-count"]')?.textContent;

describe('the first run’s cards', () => {
  it('puts the Feed’s title over the card, with what it is and how many are ready', async () => {
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    expect(q('[data-testid="first-win"] h3')!.textContent).toBe('Feed');
    expect(count()).toBe('1 of 3');
    // The group says what the card is, with Home's own group dot (not a pill of its own).
    const group = q('[data-testid="first-win-group"]')!;
    expect(group.textContent).toBe('Needs you');
    expect(group.querySelector('.hf-group-dot')!.getAttribute('data-tone')).toBe('warn');
    expect(q('.fw-tab')).toBeNull();
  });

  it('is a plain Feed card: no amber edge or tint of its own', async () => {
    await vi.waitFor(() => expect(q('.fw-front > [data-feed-id]')).not.toBeNull());
    const row = q('.fw-front > [data-feed-id]')!;
    expect(row.dataset.needs).toBe('true');
    expect(getComputedStyle(row).boxShadow).toBe('none');
    expect(getComputedStyle(row).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });

  it('‹ › cycle the ready cards, round the end', async () => {
    await vi.waitFor(() => expect(count()).toBe('1 of 3'));
    await click(button(host, /^Show me another$/));
    expect(q('[data-feed-id="sim:review"]')).not.toBeNull();
    expect(count()).toBe('2 of 3');
    await click(button(host, /The card before/));
    await click(button(host, /The card before/));
    expect(q('[data-feed-id="sim:fix"]')).not.toBeNull();
    expect(count()).toBe('3 of 3');
  });

  it('cards that land while Rig reads join the cycle; the one in front stays', async () => {
    shownCards = 1;
    await mount(2);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(1);
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    // One card: nothing to cycle.
    expect(q('[data-testid="first-win-cycle"]')).toBeNull();
    shownCards = 3;
    await mount(2);
    await vi.waitFor(() => expect(count()).toBe('1 of 3'));
    expect(q('[data-feed-id="sim:reply"]')).not.toBeNull();
  });

  it('sends the drafted answer, and that win ends the first run after a moment', async () => {
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    await click(button(q('[data-feed-id="sim:reply"]')!, /Next option/));
    expect(q('[data-feed-draft]')!.textContent).toContain('Thursday’s tight for me.');
    await click(button(q('[data-feed-id="sim:reply"]')!, /^Send/));
    await vi.waitFor(() => expect(q('[data-feed-sent]')).not.toBeNull());
    expect(sent).toEqual(['Thursday’s tight for me. Does Friday morning work? Happy to go through the numbers async before.']);
    expect(q('[data-feed-sent]')!.textContent).toContain('Sent in #product.');
    // No next card comes forward, and nothing to cycle.
    expect(q('[data-feed-id="sim:review"]')).toBeNull();
    expect(q('[data-testid="first-win-cycle"]')).toBeNull();
    expect(q('[data-testid="first-win-lead"]')!.textContent).toContain('Taking you to your Home');
    expect(won).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(won).toHaveBeenCalledTimes(1), { timeout: WIN_HOLD_MS + 1000 });
  });

  it('a started card is the win too, and its Open goes to the session in its space', async () => {
    await vi.waitFor(() => expect(count()).toBe('1 of 3'));
    await click(button(host, /The card before/));
    await vi.waitFor(() => expect(q('[data-feed-id="sim:fix"]')).not.toBeNull());
    await click(button(q('[data-feed-id="sim:fix"]')!, /Start/));
    await vi.waitFor(() => expect(q('[data-feed-sent]')?.textContent).toContain('Started in #home'));
    await click(button(q('[data-feed-sent]')!, /Open/));
    expect(opened).toEqual([['/Rig/home', 'ses_started']]);
    await vi.waitFor(() => expect(won).toHaveBeenCalledTimes(1), { timeout: WIN_HOLD_MS + 1000 });
    expect(won.mock.calls[0]![0].session).toEqual({ root: '/Rig/home', sessionId: 'ses_started' });
  });

  it('Not now lets the front card go, and the next one comes forward', async () => {
    await vi.waitFor(() => expect(q('[data-feed-id="sim:reply"]')).not.toBeNull());
    await click(button(q('[data-feed-id="sim:reply"]')!, /More/));
    await click(button(host, /Not now/));
    expect(q('[data-feed-id="sim:review"]')).not.toBeNull();
    expect(count()).toBe('1 of 2');
  });
});
