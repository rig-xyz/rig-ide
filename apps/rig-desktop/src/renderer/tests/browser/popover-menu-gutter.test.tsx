import { RotateCcw } from 'lucide-react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PopoverMenuItem } from '@renderer/lib/ui/popover';

/** A menu row with no icon of its own keeps an icon's room, so its label lines up with the rows that have one (a session's Retry menu). */

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
});

describe('PopoverMenuItem iconGutter', () => {
  it('lines its label up with an icon row above it', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    host.style.width = '200px';
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <div>
          <PopoverMenuItem label="Again with Claude" icon={RotateCcw} onSelect={() => {}} />
          <PopoverMenuItem label="With Codex" iconGutter onSelect={() => {}} />
        </div>
      )
    );
    const row = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
    // The gutter takes the icon's own place: the same size, ahead of the label, with the same gap.
    const icon = row('Again with Claude').querySelector('svg')!;
    const gutter = row('With Codex').querySelector('[data-icon-gutter]')!;
    expect(gutter).toBeTruthy();
    expect(gutter.getAttribute('class')).toBe(icon.getAttribute('class')!.replace(/\blucide\S*\s*/g, '').trim());
    expect(row('With Codex').firstElementChild).toBe(gutter);
    expect(row('With Codex').className).toBe(row('Again with Claude').className);
  });
});
