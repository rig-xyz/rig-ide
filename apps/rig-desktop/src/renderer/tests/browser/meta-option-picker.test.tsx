import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetaOptionPicker } from '@renderer/features/chat/meta-option-picker';

/**
 * Round: model picker id subtext — "which version is Default" was
 * unanswerable from the display name alone. `MetaOptionPicker`'s dropdown
 * rows now show each option's raw id as muted mono subtext, but ONLY when
 * it's a genuinely different string from the display name — never
 * fabricated, and a no-op for option sets (effort tiers: "low"/"medium"/
 * "high") where id and name already match.
 */

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

describe('MetaOptionPicker — id subtext in dropdown rows', () => {
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

  it('shows the raw id as muted subtext when it differs from the display name (model options)', async () => {
    await act(async () => {
      root.render(
        <MetaOptionPicker
          options={[
            { id: 'claude-sonnet-4-5-20260115', name: 'Default (recommended)' },
            { id: 'claude-haiku-4-5-20260115', name: 'Fast' },
          ]}
          selectedId="claude-sonnet-4-5-20260115"
          onChange={() => {}}
          placeholder="Model"
        />
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')?.click();
    });

    expect(document.body.textContent).toContain('Default (recommended)');
    expect(document.body.textContent).toContain('claude-sonnet-4-5-20260115');
    expect(document.body.textContent).toContain('Fast');
    expect(document.body.textContent).toContain('claude-haiku-4-5-20260115');
  });

  it('never fabricates a subtext line when the id and name are the same string (effort tiers)', async () => {
    await act(async () => {
      root.render(
        <MetaOptionPicker
          options={[
            { id: 'low', name: 'low' },
            { id: 'high', name: 'high' },
          ]}
          selectedId="low"
          onChange={() => {}}
          placeholder="Effort"
        />
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')?.click();
    });

    const rows = document.querySelectorAll('[role="option"]');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      // Exactly one "line" span (the name) per row — never a second
      // (subtext) line when id and name are the same string.
      expect(row.querySelectorAll('span.block.truncate').length).toBe(1);
    }
  });
});
