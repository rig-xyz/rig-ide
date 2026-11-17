import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  RunTriggerLine,
  SpaceViewLinksContext,
} from '@renderer/features/spaces/components/run-trigger-line';
import type { ViewManifest } from '@shared/rig/views';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = { name: '1-inbox', kind: 'intake', icon: null, order: null, title: 'Inbox' } as ViewManifest;

async function show(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, done: () => (act(() => root.unmount()), host.remove()) };
}

it('a press in a view shows as a chip naming the tab, the button and the item, and opens the tab', async () => {
  const onOpenView = vi.fn();
  const { host, done } = await show(
    <SpaceViewLinksContext.Provider value={{ views: [view], onOpenView }}>
      <RunTriggerLine
        trigger={{ by: 'view', view: '1-inbox', label: 'Draft a post', item: 'Alex on idea basins', note: 'short one' }}
        mine
      />
    </SpaceViewLinksContext.Provider>
  );
  const chip = host.querySelector<HTMLButtonElement>('[data-testid="run-trigger-open"]')!;
  expect(chip.textContent).toBe('Inbox·Draft a post·Alex on idea basins');
  expect(host.textContent).toContain('short one');
  await act(async () => chip.click());
  expect(onOpenView).toHaveBeenCalledWith('1-inbox');
  done();
});

it('is not a link where the Room cannot open tabs, and names the view by its folder', async () => {
  const { host, done } = await show(
    <RunTriggerLine trigger={{ by: 'view', view: 'drafts', label: 'Approve' }} mine={false} />
  );
  expect(host.querySelector('[data-testid="run-trigger-open"]')).toBeNull();
  expect(host.querySelector('[data-testid="run-trigger"]')!.textContent).toBe('drafts·Approve');
  done();
});

it('a scheduled pass and Rig\'s own look are quiet lines', async () => {
  const { host, done } = await show(
    <SpaceViewLinksContext.Provider value={{ views: [view] }}>
      <RunTriggerLine trigger={{ by: 'clock', view: '1-inbox' }} mine />
      <RunTriggerLine trigger={{ by: 'gardener' }} mine />
    </SpaceViewLinksContext.Provider>
  );
  const lines = [...host.querySelectorAll('[data-testid="run-trigger"]')].map((el) => el.textContent);
  expect(lines).toEqual(['Inbox refreshed on schedule', 'Rig looked after this space']);
  done();
});
