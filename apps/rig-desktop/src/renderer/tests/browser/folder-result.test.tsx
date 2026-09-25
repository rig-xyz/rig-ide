import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.4.3: opening a space/rig from Home flashed a folder picker (the
 * generic folder card: path, "Checking…", "Open Folder…") for the length
 * of `detect`. While detecting, `FolderResult` now shows nothing, then a
 * quiet "Opening…" only if the open is slow.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: { status: async () => ({ signedIn: true }) },
      recent: { recentRigs: async () => [] },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { FolderResult } from '@renderer/App';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('FolderResult while detecting', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('shows no folder card — nothing at first, then a quiet "Opening…"', async () => {
    await act(async () => {
      root.render(
        <FolderResult
          folder={{ status: 'detecting', path: '/Users/me/Rig/growth' }}
          onOpenFolder={() => {}}
          onRetryOpen={() => {}}
          onCancel={() => {}}
        />
      );
    });
    expect(host.textContent).toBe('');
    expect(host.querySelector('button')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(host.textContent).toBe('Opening…');
    expect(host.textContent).not.toContain('/Users/me/Rig/growth');
    expect(host.querySelector('button')).toBeNull();
  });

  it('still offers "Open Folder…" when the open fails', async () => {
    await act(async () => {
      root.render(
        <FolderResult
          folder={{ status: 'error', path: '/Users/me/Rig/growth', message: 'Could not check this folder.' }}
          onOpenFolder={() => {}}
          onRetryOpen={() => {}}
          onCancel={() => {}}
        />
      );
    });
    expect(host.textContent).toContain('Could not check this folder.');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('Open Folder…');
  });
});
