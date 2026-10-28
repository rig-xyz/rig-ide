import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Home's chat with Rig's notes on the work it started: each in among the
 * runs by time, saying what it started or that it's ready, with an Open to
 * the session.
 */

vi.mock('@renderer/lib/ipc', () => ({ rpc: { rig: { homeChat: {} } }, events: { on: () => () => {} } }));

import { HomeRuns } from '@renderer/features/home-feed/home-claude';
import type { HomeNote } from '@renderer/features/home-feed/home-notes';
import type { HomeChatRun } from '@shared/rig/home-chat';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const T = Date.parse('2026-10-28T09:00:00Z');
const run: HomeChatRun = { id: 'r1', prompt: 'What needs me?', at: new Date(T + 60_000).toISOString(), status: 'done', endedAt: new Date(T + 70_000).toISOString(), model: 'opus', events: [] };
const note = (id: string, kind: HomeNote['kind'], at: number): HomeNote => ({ id, kind, at, title: 'Fix the payout retry', root: '/Rig/home', sessionId: 'ses_1' });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'height:700px;width:800px;display:flex;flex-direction:column';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Rig's notes in Home's chat", () => {
  it('sits in among the runs by time, and its Open goes to the session', async () => {
    const opened: string[] = [];
    await act(async () => {
      root.render(
        <HomeRuns
          runs={[run]}
          notes={[note('n1', 'started', T), note('n2', 'review', T + 120_000)]}
          onOpenNote={(n) => opened.push(`${n.root}#${n.sessionId}`)}
          name="Dylan"
          header={null}
        />
      );
    });
    const order = [...host.querySelectorAll('[data-home-note], [data-message-id]')].map((el) => el.getAttribute('data-home-note') ?? 'message');
    expect(order[0]).toBe('started');
    expect(order.at(-1)).toBe('review');
    const started = host.querySelector('[data-home-note="started"]')!;
    expect(started.textContent).toContain("Started working on Fix the payout retry. I'll let you know when it's done.");
    expect(host.querySelector('[data-home-note="review"]')!.textContent).toContain('Fix the payout retry is ready for review.');
    await act(async () => [...started.querySelectorAll('button')].find((b) => b.textContent?.includes('Open'))!.click());
    expect(opened).toEqual(['/Rig/home#ses_1']);
    // The person's message sits between them.
    expect(host.textContent!.indexOf('What needs me?')).toBeGreaterThan(host.textContent!.indexOf('Started working on'));
    expect(host.textContent!.indexOf('What needs me?')).toBeLessThan(host.textContent!.indexOf('is ready for review'));
  });
});
