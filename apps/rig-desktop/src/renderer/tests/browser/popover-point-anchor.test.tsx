import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Popover, PopoverMenuItem } from '@renderer/lib/ui/popover';
import type { ContextMenuPoint } from '@renderer/lib/ui/popover-types';

/**
 * Repro harness for the "popover open crashes to the recovery surface"
 * report (session-first feedback round 1): mount the primitive exactly the
 * way the pinned card's Skills/People rows now do — a POINT anchor and
 * gap 0 — and assert the open render doesn't throw.
 */

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Popover point anchors', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('renders open with a point anchor without throwing', () => {
    act(() => {
      root.render(
        <Popover
          anchor={{ x: 120, y: 80 }}
          open
          onClose={() => {}}
          role="menu"
          align="right"
          gap={0}
          estimatedWidth={230}
          minWidth={230}
          ariaLabel="Point anchored"
        >
          <PopoverMenuItem label="First" onSelect={() => {}} />
          <PopoverMenuItem label="Second" onSelect={() => {}} />
        </Popover>
      );
    });
    const menu = document.querySelector('[role="menu"][aria-label="Point anchored"]');
    expect(menu).not.toBeNull();
  });

  it('renders open as a dialog with a point anchor without throwing', () => {
    act(() => {
      root.render(
        <Popover
          anchor={{ x: 300, y: 200 }}
          open
          onClose={() => {}}
          role="dialog"
          align="right"
          gap={0}
          estimatedWidth={320}
          minWidth={320}
          ariaLabel="Dialog point"
        >
          <div>content</div>
        </Popover>
      );
    });
    const dialog = document.querySelector('[role="dialog"][aria-label="Dialog point"]');
    expect(dialog).not.toBeNull();
  });

  it('opens from a row click that derives the point in a state updater (the recovery-surface regression)', () => {
    // The pinned card's Skills/People rows: click → measure the row →
    // point-anchored popover. The original code read `event.currentTarget`
    // INSIDE the setState updater — by the time React runs it, the event
    // has finished dispatching and `currentTarget` is null, so measuring
    // threw a TypeError straight into the recovery boundary. This fixture
    // mirrors the fixed pattern (capture before the updater) and fails if
    // the click path ever throws again.
    function Row() {
      const [anchor, setAnchor] = useState<ContextMenuPoint | null>(null);
      return (
        <>
          <button
            type="button"
            onClick={(event) => {
              const row = event.currentTarget;
              setAnchor((current) =>
                current ? null : { x: row.getBoundingClientRect().left - 8, y: row.getBoundingClientRect().top }
              );
            }}
          >
            Skills
          </button>
          <Popover
            anchor={anchor ?? { x: 0, y: 0 }}
            open={anchor !== null}
            onClose={() => setAnchor(null)}
            role="menu"
            align="right"
            gap={0}
            ariaLabel="Row anchored"
          >
            <PopoverMenuItem label="A skill" onSelect={() => {}} />
          </Popover>
        </>
      );
    }
    act(() => {
      root.render(<Row />);
    });
    const button = host.querySelector('button');
    expect(button).not.toBeNull();
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"][aria-label="Row anchored"]')).not.toBeNull();
  });
});
