import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDiagnosticLogAttachment: vi.fn(),
  clipboardWriteText: vi.fn(),
  saveTextFile: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: mocks },
}));

import { RecoveryBoundary } from '@renderer/features/recovery/recovery-boundary';
import { RecoverySurface } from '@renderer/features/recovery/recovery-surface';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('renderer recovery surfaces', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.getDiagnosticLogAttachment.mockResolvedValue({ content: 'safe diagnostics' });
    mocks.clipboardWriteText.mockResolvedValue({ success: true });
    mocks.saveTextFile.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('renders an actionable fallback when a feature throws during render', async () => {
    function BrokenFeature(): React.ReactElement {
      throw new Error('feature exploded');
    }

    await act(async () => {
      root.render(
        <RecoveryBoundary scope="Chat panel">
          <BrokenFeature />
        </RecoveryBoundary>
      );
    });

    expect(host.textContent).toContain('Rig recovery');
    expect(host.textContent).toContain('Chat panel failed to render');
    expect(host.textContent).toContain('Reload Window');
    expect(host.textContent).toContain('Copy diagnostics');
  });

  it('exposes retry for a failed boot surface', async () => {
    const onRetry = vi.fn();
    await act(async () => {
      root.render(<RecoverySurface state="failed" onRetry={onRetry} />);
    });

    const retry = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Retry startup')
    );
    await act(async () => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
