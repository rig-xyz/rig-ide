import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ViewIcon } from '@renderer/features/views/view-icon';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("a view shows the icon its view.json names, else its kind's", async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <>
        <ViewIcon view={{ kind: 'queue', icon: 'send' }} data-testid="named" />
        <ViewIcon view={{ kind: 'intake', icon: 'no-such-icon' }} data-testid="unknown" />
      </>
    );
  });
  const svg = (id: string) => host.querySelector(`[data-testid="${id}"]`);
  await vi.waitFor(() => expect(svg('named')?.classList.contains('lucide-send')).toBe(true));
  expect(svg('unknown')?.classList.contains('lucide-inbox')).toBe(true);
  act(() => root.unmount());
  host.remove();
});
