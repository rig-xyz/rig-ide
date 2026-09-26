import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The doc header's share button (Dylan, 2026-09-26): a quiet icon beside the
 * file's name, "Share file", never confused with a space's accent "Invite"
 * pill. Only the closed trigger is exercised here (`Popover` renders nothing
 * until opened, so this needs no further RPC mocking — see
 * `rig-share-compact.test.tsx` for a popover-open example).
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

  it('is a quiet icon labelled "Share file", never an accent pill', async () => {
    await act(async () => {
      root.render(<ShareButton absPath="/rigs/growth/notes.md" />);
    });
    const button = host.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Share file');
    expect(button.textContent?.trim()).toBe('');
    // Ghost/quiet: no bordered pill chrome.
    expect(button.className).not.toMatch(/\bborder\b/);
    expect(button.className).not.toContain('bg-accent');
  });
});
