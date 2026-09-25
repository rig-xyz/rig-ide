import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Polish round 2, lane F (Dylan): the doc header's own file-link button
 * (next to the view/code toggle, mints a public share link) is never
 * confused with a space's accent "Invite" pill — relabeled "Link", ghost/
 * quiet styling, no border. Only the closed trigger is exercised here
 * (`Popover` renders nothing until opened, so this needs no further RPC
 * mocking — see `rig-share-compact.test.tsx` for a popover-open example).
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { rig: {} },
  events: { on: vi.fn(() => () => {}) },
}));

import { ShareButton } from '@renderer/features/artifact/share-popover';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('the doc header\'s share-link button', () => {
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

  it('reads "Link", not "Share", in a quiet/ghost style — never confused with Invite', async () => {
    await act(async () => {
      root.render(<ShareButton absPath="/rigs/growth/notes.md" />);
    });
    const button = host.querySelector('button')!;
    expect(button.textContent?.trim()).toBe('Link');
    expect(button.textContent).not.toContain('Share');
    // Ghost/quiet: no bordered pill chrome.
    expect(button.className).not.toMatch(/\bborder\b/);
    expect(button.className).not.toContain('bg-accent');
  });
});
