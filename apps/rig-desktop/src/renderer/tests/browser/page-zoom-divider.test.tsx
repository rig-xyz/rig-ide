import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageZoomControl, readChosenZoom, usePageZoom } from '@renderer/features/pages/page-zoom';
import { ChatDivider } from '@renderer/features/shell/chat-divider';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.removeItem('rig-page-zoom');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function q(testId: string): HTMLElement {
  return host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
}

describe('page zoom — the toolbar control', () => {
  function Harness({ site, width }: { site: string; width: number }) {
    const zoom = usePageZoom(site, width);
    return <PageZoomControl factor={zoom.factor} fitted={zoom.fitted} onPress={zoom.press} />;
  }

  it('fits the panel until you zoom; − / + step and are remembered for the site; reset goes back to the fit', async () => {
    await act(async () => root.render(<Harness site="example.com" width={820} />));
    expect(q('page-zoom-level').textContent).toBe('80%');
    expect(q('page-zoom-level').dataset.fitted).toBe('true');
    expect((q('page-zoom-reset') as HTMLButtonElement).disabled).toBe(true);

    // The fit follows the panel's width.
    await act(async () => root.render(<Harness site="example.com" width={1300} />));
    expect(q('page-zoom-level').textContent).toBe('100%');

    await act(async () => click(q('page-zoom-in')));
    expect(q('page-zoom-level').textContent).toBe('110%');
    expect(q('page-zoom-level').dataset.fitted).toBeUndefined();
    expect(readChosenZoom('example.com')).toBe(1.1);
    // Chosen: it no longer follows the panel.
    await act(async () => root.render(<Harness site="example.com" width={700} />));
    expect(q('page-zoom-level').textContent).toBe('110%');
    await act(async () => click(q('page-zoom-out')));
    await act(async () => click(q('page-zoom-out')));
    expect(q('page-zoom-level').textContent).toBe('90%');
    expect(readChosenZoom('example.com')).toBe(0.9);

    // Another site has its own (none yet: the fit).
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Harness site="other.org" width={700} />));
    expect(q('page-zoom-level').textContent).toBe('67%');
    // Back on the first site, the zoom you chose is still there.
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Harness site="example.com" width={700} />));
    expect(q('page-zoom-level').textContent).toBe('90%');

    await act(async () => click(q('page-zoom-reset')));
    expect(q('page-zoom-level').textContent).toBe('67%');
    expect(q('page-zoom-level').dataset.fitted).toBe('true');
    expect(readChosenZoom('example.com')).toBeNull();
  });

  it("stops at the ends: − and + can't go past the smallest and largest steps", async () => {
    const onPress = vi.fn();
    await act(async () => root.render(<PageZoomControl factor={0.25} fitted={false} onPress={onPress} />));
    expect((q('page-zoom-out') as HTMLButtonElement).disabled).toBe(true);
    expect((q('page-zoom-in') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => root.render(<PageZoomControl factor={5} fitted={false} onPress={onPress} />));
    expect((q('page-zoom-in') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the chat / panel divider', () => {
  function pointer(type: string, clientX: number, target: EventTarget = window): void {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, button: 0, pointerId: 1 }));
  }
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

  async function renderDivider(measured = { width: 600, min: 280, max: 800 }) {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const onReset = vi.fn();
    const page = document.createElement('webview');
    document.body.appendChild(page);
    await act(async () =>
      root.render(
        <div style={{ display: 'flex', height: 200 }}>
          <div style={{ width: 300 }} />
          <ChatDivider measure={() => measured} onResize={onResize} onResizeEnd={onResizeEnd} onReset={onReset} />
          <div style={{ flex: 1 }} />
        </div>
      )
    );
    return { onResize, onResizeEnd, onReset, page, cleanup: () => page.remove() };
  }

  it('is easy to grab: the grab area reaches past the handle on both sides', async () => {
    const { cleanup } = await renderDivider();
    const handle = q('chat-divider').getBoundingClientRect();
    const grab = q('chat-divider-grab').getBoundingClientRect();
    expect(grab.left).toBeLessThan(handle.left);
    expect(grab.right).toBeGreaterThan(handle.right);
    expect(grab.width).toBe(8 + 2 * 6);
    cleanup();
  });

  it("follows the pointer from the chat's drawn width (no dead zone), within bounds, and lets the pointer through a page while dragging", async () => {
    const { onResize, onResizeEnd, page, cleanup } = await renderDivider();
    pointer('pointerdown', 500, q('chat-divider-grab'));
    expect(page.style.pointerEvents).toBe('none');

    pointer('pointermove', 450);
    await nextFrame();
    expect(onResize).toHaveBeenLastCalledWith(550); // the first 50px move is 50px, from the drawn 600

    pointer('pointermove', 900); // past the max
    await nextFrame();
    expect(onResize).toHaveBeenLastCalledWith(800);
    pointer('pointermove', 0); // past the min
    pointer('pointerup', 0);
    expect(onResize).toHaveBeenLastCalledWith(280);
    expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith(280);
    expect(page.style.pointerEvents).toBe('');
    cleanup();
  });

  it('a click without a move stores nothing; a double-click resets to the default split', async () => {
    const { onResize, onResizeEnd, onReset, cleanup } = await renderDivider();
    pointer('pointerdown', 500, q('chat-divider-grab'));
    pointer('pointerup', 500);
    expect(onResize).not.toHaveBeenCalled();
    expect(onResizeEnd).not.toHaveBeenCalled();
    q('chat-divider-grab').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onReset).toHaveBeenCalledOnce();
    cleanup();
  });
});
