import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Onboarding's Connect on a recorded Claude: it lists every tool Claude has,
 * by its own name, a known one with its logo and any other with a neutral
 * mark; each connected tool is on by default; a switch writes the choice;
 * the tools Claude doesn't have are one quiet "Connect more" link.
 */

vi.mock('@renderer/lib/ipc', () => ({ rpc: {}, events: { on: () => () => {} } }));

import { ConnectStep } from '@renderer/features/first-run/connect/connect-step';
import type { FirstRunEnv } from '@renderer/features/first-run/env';
import type { ConnectorCheck } from '@shared/rig/first-run';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const TOOLS: ConnectorCheck[] = [
  { connector: 'Slack', known: 'slack', state: 'connected' },
  { connector: 'Granola', known: 'granola', state: 'connected' },
  { connector: 'Google Drive', known: null, state: 'connected' },
  { connector: 'Ramp', known: null, state: 'needs_auth' },
  { connector: 'GitHub', known: 'github', state: 'connected' },
];

let host: HTMLDivElement;
let root: Root;
let writes: [string, boolean][];
let opened: (string | undefined)[];
let next: ReturnType<typeof vi.fn<() => void>>;
beforeEach(async () => {
  host = document.createElement('div');
  host.style.cssText = 'height:800px;width:1100px;display:grid;grid-template-columns:370px 1fr';
  document.body.appendChild(host);
  root = createRoot(host);
  writes = [];
  opened = [];
  next = vi.fn<() => void>();
  const env = {
    agentInfo: { name: 'Claude Code', icon: null, route: { yours: 'your Claude', connectorsHome: 'claude.ai' } },
    preflight: () => Promise.resolve(TOOLS),
    readWatching: () => Promise.resolve({}),
    setWatching: (connector: string, on: boolean) => {
      writes.push([connector, on]);
      return Promise.resolve();
    },
    catchUpSince: () => Promise.resolve(null),
    openConnect: (connector?: string) => opened.push(connector),
  } as unknown as FirstRunEnv;
  await act(async () => {
    root.render(
      <ConnectStep
        env={env}
        plan={null}
        position="Step 2 of 5"
        onNext={next}
        advancing={false}
        setFieldLook={() => {}}
        field={{ current: null }}
        openSession={null}
      />
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const q = (sel: string) => host.querySelector<HTMLElement>(sel);
async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
}

describe('Connect', () => {
  it("lists every tool Claude has, by its own name, with its logo or a neutral mark", async () => {
    await vi.waitFor(() => expect(q('[data-testid="connect-row-google drive"]')).not.toBeNull());
    const rows = [...host.querySelectorAll('[data-testid^="connect-row-"]')].map((r) => r.querySelector('.text-ui')?.textContent);
    expect(rows).toEqual(['Slack', 'Granola', 'Google Drive', 'Ramp', 'GitHub']);
    // Drive has no logo of Rig's own: its initial, on a quiet tile.
    expect(q('[data-testid="connect-row-google drive"] [data-tool-mark="neutral"]')!.textContent).toBe('G');
    expect(q('[data-testid="connect-row-slack"] [data-tool-mark="neutral"]')).toBeNull();
    // Ramp asks to sign in again: a Reconnect, no switch.
    expect(q('[data-testid="connect-row-ramp"]')!.dataset.state).toBe('needs_auth');
    await click(q('[data-testid="connect-open-ramp"]'));
    expect(opened).toEqual(['Ramp']);
  });

  it('turns every connected tool on, and a switch writes that one choice', async () => {
    await vi.waitFor(() => expect(q('[data-testid="connect-row-slack"]')).not.toBeNull());
    const switches = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches.map((s) => s.getAttribute('aria-label'))).toEqual(['Read Slack', 'Read Granola', 'Read Google Drive', 'Read GitHub']);
    expect(switches.every((s) => s.getAttribute('aria-checked') === 'true')).toBe(true);
    expect(host.textContent).toContain('Reads the last 3 days of 4 tools');
    await click(switches[2]);
    expect(writes).toEqual([['Google Drive', false]]);
    expect(host.textContent).toContain('Reads the last 3 days of 3 tools');
  });

  it('Catch me up writes the whole choice, then starts the read', async () => {
    await vi.waitFor(() => expect(q('[data-testid="connect-row-slack"]')).not.toBeNull());
    await click(host.querySelector('[aria-label="Read Granola"]'));
    writes = [];
    await click(q('[data-testid="first-run-catch-me-up"]'));
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(writes).toEqual([
      ['Slack', true],
      ['Granola', false],
      ['Google Drive', true],
      ['GitHub', true],
    ]);
  });

  it("offers the tools Claude doesn't have as one quiet link, not a row each", async () => {
    await vi.waitFor(() => expect(q('[data-testid="connect-more"]')).not.toBeNull());
    expect(q('[data-testid="connect-row-notion"]')).toBeNull();
    expect(q('[data-testid="connect-more"]')!.textContent).toBe('Connect more in claude.ai ↗');
    await click(q('[data-testid="connect-more"]'));
    expect(opened).toEqual([undefined]);
  });

  it('pins each connected tool on the stage', async () => {
    await vi.waitFor(() => expect(q('[data-testid="connect-pin-slack"]')).not.toBeNull());
    expect([...host.querySelectorAll('[data-testid^="connect-pin-"]')].map((p) => p.getAttribute('data-testid'))).toEqual([
      'connect-pin-slack',
      'connect-pin-granola',
      'connect-pin-google drive',
      'connect-pin-github',
    ]);
  });
});
