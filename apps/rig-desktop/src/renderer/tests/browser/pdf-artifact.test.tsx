import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfArtifact } from '@renderer/features/artifact/pdf-artifact';
import { rpc } from '@renderer/lib/ipc';
import { tinyPdfBase64 } from './pdf-fixture';
import '@renderer/tokens.css';

/**
 * The PDF viewer beside the chat (pdf.js, real worker): pages drawn to
 * canvases in one scrolling column that fits the panel, the page count, zoom,
 * "Open in default app", and only pages near the view hold a bitmap.
 * Tailwind isn't loaded here: the few utilities the scroll box's layout
 * rests on are stubbed below, and layout assertions stick to real sizes.
 */
const LAYOUT_UTILITIES = `
  .flex { display: flex } .flex-col { flex-direction: column } .h-full { height: 100% }
  .min-h-0 { min-height: 0 } .flex-1 { flex: 1 1 0% } .shrink-0 { flex-shrink: 0 }
  .overflow-auto { overflow: auto } .h-9 { height: 2.25rem }
`;

const mocks = vi.hoisted(() => ({ readBinary: vi.fn<(args: unknown) => Promise<unknown>>() }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: { files: { readBinary: (...args: unknown[]) => mocks.readBinary(args[0]) } },
    app: {
      openPath: vi.fn(async () => ({ success: true, data: undefined })),
      showItemInFolder: vi.fn(async () => ({ success: true, data: undefined })),
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const style = document.createElement('style');
  style.textContent = LAYOUT_UTILITIES;
  document.head.appendChild(style);
});

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error('waitFor timed out');
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  // A side panel: 420 wide, 600 tall.
  host.style.width = '420px';
  host.style.height = '600px';
  host.style.display = 'flex';
  host.style.flexDirection = 'column';
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.readBinary.mockReset();
  vi.mocked(rpc.app.openPath).mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function pdf(pages: number) {
  const data = tinyPdfBase64(pages);
  return { success: true, data: { data, truncated: false, size: atob(data).length } };
}

async function open(path = '/space/attachments/deck.pdf') {
  await act(async () => {
    root.render(<PdfArtifact root="/space" rootId="space-1" path={path} />);
  });
}

const pagesEl = () => [...host.querySelectorAll<HTMLElement>('[data-testid="pdf-page"]')];
const scroller = () => host.querySelector<HTMLElement>('[data-testid="pdf-scroller"]')!;

/** The RGBA at the middle of a drawn page's canvas. */
function centerPixel(page: HTMLElement): number[] {
  const canvas = page.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  return [...ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
}

describe('PdfArtifact', () => {
  it('reads the file through readBinary (never a URL), then draws its pages and says how many', async () => {
    mocks.readBinary.mockResolvedValue(pdf(2));
    await open();
    expect(host.textContent).toContain('Loading…');
    await waitFor(() => pagesEl().length === 2 && pagesEl()[0]!.dataset.drawn === 'true');

    expect(mocks.readBinary).toHaveBeenCalledWith({ rootId: 'space-1', relativePath: 'attachments/deck.pdf', maxBytes: 64 * 1024 * 1024 });
    expect(host.querySelector('[data-testid="pdf-page-indicator"]')?.textContent).toBe('Page 1 of 2');
    // The rectangle really was drawn: blue in the middle of page 1.
    const [r, g, b] = centerPixel(pagesEl()[0]!);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
    expect(g).toBeLessThan(60);
  });

  it("lays each page's text over it, selectable, in the page's element (what a comment would anchor to)", async () => {
    mocks.readBinary.mockResolvedValue(pdf(2));
    await open();
    await waitFor(() => pagesEl()[0]?.dataset.text === 'ready');
    const page = pagesEl()[0]!;
    expect(page.dataset.page).toBe('1');
    const layer = page.querySelector<HTMLElement>('[data-testid="pdf-text-layer"]')!;
    expect(layer.textContent).toContain('Quarterly results page 1');
    const run = [...layer.querySelectorAll('span')].find((s) => s.textContent?.includes('Quarterly'))!;
    // Invisible over the drawn text, and selectable.
    expect(getComputedStyle(run).color).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(run).userSelect).toBe('text');
    const range = document.createRange();
    range.selectNodeContents(run);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    expect(getSelection()!.toString()).toContain('Quarterly results page 1');
    getSelection()!.removeAllRanges();
    // Laid over the page: it sits within the page's box, near the top where the line is.
    const box = page.getBoundingClientRect();
    const at = run.getBoundingClientRect();
    expect(at.left).toBeGreaterThanOrEqual(box.left);
    expect(at.right).toBeLessThanOrEqual(box.right + 1);
    expect(at.top - box.top).toBeLessThan(box.height * 0.15);

    // A zoom rescales it with the page instead of rebuilding it.
    const widthBefore = at.width;
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    expect(run.isConnected).toBe(true);
    expect(run.getBoundingClientRect().width).toBeCloseTo(widthBefore * 1.1, 0);
  });

  it('fits the panel: a page is as wide as the panel less its padding, at its own proportions', async () => {
    mocks.readBinary.mockResolvedValue(pdf(1));
    await open();
    await waitFor(() => pagesEl()[0]?.dataset.drawn === 'true');
    const page = pagesEl()[0]!;
    const available = scroller().clientWidth - 32;
    expect(page.getBoundingClientRect().width).toBeCloseTo(available, 0);
    expect(page.getBoundingClientRect().height).toBeCloseTo((available * 400) / 300, 0);
    expect(scroller().scrollWidth).toBeLessThanOrEqual(scroller().clientWidth);
  });

  it('zooms in and out from the fit, and back to it', async () => {
    mocks.readBinary.mockResolvedValue(pdf(1));
    await open();
    await waitFor(() => pagesEl()[0]?.dataset.drawn === 'true');
    const zoomLabel = () => host.querySelector('[data-testid="pdf-zoom"]')!.textContent;
    const fitWidth = pagesEl()[0]!.getBoundingClientRect().width;
    expect(zoomLabel()).toBe('Fit');

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    expect(zoomLabel()).toBe('110%');
    expect(pagesEl()[0]!.getBoundingClientRect().width).toBeCloseTo(Math.round(fitWidth * 1.1), 0);

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
    expect(zoomLabel()).toBe('90%');

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Fit to width"]')!.click());
    expect(zoomLabel()).toBe('Fit');
    expect(pagesEl()[0]!.getBoundingClientRect().width).toBeCloseTo(fitWidth, 0);
  });

  it('keeps "Open in default app" on hand', async () => {
    mocks.readBinary.mockResolvedValue(pdf(1));
    await open();
    await waitFor(() => pagesEl().length === 1);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open in default app"]')!.click());
    expect(rpc.app.openPath).toHaveBeenCalledWith('/space/attachments/deck.pdf');
  });

  it('a long PDF draws only the pages near the view, and follows the page you scroll to', async () => {
    mocks.readBinary.mockResolvedValue(pdf(40));
    await open();
    await waitFor(() => pagesEl().length === 40 && pagesEl()[0]!.dataset.drawn === 'true');
    const drawn = () => pagesEl().filter((p) => p.dataset.drawn === 'true').map((p) => Number(p.dataset.page));
    expect(drawn().length).toBeLessThan(10);
    expect(drawn()).not.toContain(40);

    const last = pagesEl()[39]!;
    await act(async () => {
      scroller().scrollTop = last.offsetTop;
      scroller().dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => last.dataset.drawn === 'true');
    expect(host.querySelector('[data-testid="pdf-page-indicator"]')?.textContent).toBe('Page 40 of 40');
    // Page 1 is far behind now: its bitmap was given back.
    await waitFor(() => pagesEl()[0]!.dataset.drawn === 'false');
    expect(pagesEl()[0]!.querySelector('canvas')!.width).toBe(0);
  });

  it('a PDF too big to read whole says so, and offers the default app', async () => {
    mocks.readBinary.mockResolvedValue({ success: true, data: { data: '', truncated: true, size: 80_000_000 } });
    await open();
    await waitFor(() => !host.textContent?.includes('Loading…'));
    expect(host.textContent).toContain('Too large to preview here (80 MB).');
    expect(host.textContent).toContain('Open in default app');
  });

  it('a file that is not really a PDF says it could not be shown, instead of hanging', async () => {
    mocks.readBinary.mockResolvedValue({ success: true, data: { data: btoa('not a pdf at all'), truncated: false, size: 16 } });
    await open();
    await waitFor(() => !host.textContent?.includes('Loading…'));
    expect(host.textContent).toContain("Couldn't show this PDF.");
    expect(host.textContent).toContain('Open in default app');
  });
});
