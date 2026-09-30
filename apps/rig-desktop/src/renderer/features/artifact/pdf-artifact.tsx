import { ExternalLink, Loader2, Minus, Plus } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { relPathFromRoot } from '@shared/rig/file-navigator-categories';
import { formatFileSize } from './file-type';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from './pdf-document';
import { currentPageAt, pageWidthFor, stepZoom, ZOOM_STEPS } from './pdf-layout';
import { openInDefaultApp, UnsupportedArtifact } from './unsupported-artifact';

/**
 * A read-only PDF viewer beside the chat: the pages in one scrolling column
 * sized to the panel, zoom relative to that fit, the page you're on, and the
 * file handed to the OS's own app one click away.
 *
 * pdf.js (`pdf-document.ts`, imported only once a PDF is opened) rather than
 * Chromium's built-in viewer: that one needs `plugins: true` on the app's own
 * window and the file served over a URL the renderer may load, while this
 * reads the bytes through the same `readBinary` call every other preview
 * uses, and shows each page as a canvas under pdf.js's selectable text layer
 * (text our own DOM holds, which comments can later anchor to; the built-in
 * viewer's text lives in a plugin process out of reach) — see that module for
 * what a PDF can't do.
 *
 * Large documents stay responsive: every page is a placeholder of the right
 * size, and only the ones in or near view are fetched and hold a rendered
 * canvas (one far off-screen gives its bitmap back), so a 500-page PDF costs
 * a few pages of memory.
 */

/** `readBinary`'s own per-read cap; a bigger PDF opens in its app instead. */
const MAX_PDF_BYTES = 64 * 1024 * 1024;
/** A zoomed page's canvas past this many device pixels is drawn smaller and scaled up, not allocated whole. */
const MAX_CANVAS_PIXELS = 16_777_216;
/** A page already drawn waits this long after a zoom or resize before being redrawn sharp (it's scaled meanwhile). */
const REDRAW_DELAY_MS = 150;
/** Padding around the column of pages, each side. */
const PAD = 16;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string; size: number | null }
  | { kind: 'ready'; doc: PDFDocumentProxy; size: number; aspect: number };

export function PdfArtifact({
  root,
  rootId,
  path,
}: {
  root: string;
  rootId: string;
  path: string;
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    void (async () => {
      const read = await rpc.rig.files
        .readBinary({ rootId, relativePath: relPathFromRoot(root, path), maxBytes: MAX_PDF_BYTES })
        .catch(() => null);
      if (cancelled) return;
      if (!read?.success) {
        setState({ kind: 'failed', message: "Couldn't read this PDF.", size: null });
        return;
      }
      const { size } = read.data;
      if (read.data.truncated) {
        setState({
          kind: 'failed',
          message: `Too large to preview here (${formatFileSize(size)}).`,
          size,
        });
        return;
      }
      try {
        const { openPdf } = await import('./pdf-document');
        if (cancelled) return;
        task = openPdf(base64ToBytes(read.data.data));
        const doc = await task.promise;
        const first = (await doc.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        setState({ kind: 'ready', doc, size, aspect: first.height / first.width });
      } catch (error) {
        if (cancelled) return;
        const locked = (error as { name?: unknown } | null)?.name === 'PasswordException';
        setState({
          kind: 'failed',
          message: locked ? 'This PDF is password-protected.' : "Couldn't show this PDF.",
          size,
        });
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
    // The caller remounts this on file change (`ArtifactView`'s `key={path}`), same as the image viewer.
  }, [root, rootId, path]);

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted">
        <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
        Loading…
      </div>
    );
  }
  if (state.kind === 'failed') {
    return (
      <UnsupportedArtifact
        root={root}
        rootId={rootId}
        path={path}
        size={state.size}
        message={state.message}
      />
    );
  }
  return <PdfPages doc={state.doc} size={state.size} firstAspect={state.aspect} path={path} />;
}

function PdfPages({
  doc,
  size,
  firstAspect,
  path,
}: {
  doc: PDFDocumentProxy;
  size: number;
  firstAspect: number;
  path: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pageEls = useRef<Array<HTMLDivElement | null>>([]);
  const [available, setAvailable] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  // Each page's own height/width once drawn; the first page's until then.
  const [aspects, setAspects] = useState<Record<number, number>>({});
  const onAspect = useCallback((pageNumber: number, aspect: number) => {
    setAspects((prev) =>
      Math.abs((prev[pageNumber] ?? 0) - aspect) < 1e-4 ? prev : { ...prev, [pageNumber]: aspect }
    );
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth - 2 * PAD);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const width = pageWidthFor(available, zoom);

  // Zooming keeps your place: the same fraction of the document stays at the top.
  const lastHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const before = lastHeight.current;
    if (before && before !== el.scrollHeight)
      el.scrollTop = (el.scrollTop / before) * el.scrollHeight;
    lastHeight.current = el.scrollHeight;
  }, [width]);

  const trackPage = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const tops = pageEls.current.map((p) => p?.offsetTop ?? 0);
    setPage(currentPageAt(tops, el.scrollTop, el.clientHeight));
  }, []);

  // A trackpad pinch (a wheel with ctrl) zooms the pages, not the app.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom((z) => clampZoom(z * Math.exp(-event.deltaY / 200)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  const minZoom = ZOOM_STEPS[0];
  const maxZoom = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="pdf-viewer">
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b border-border-hairline px-3 text-xs text-text-muted"
        data-testid="pdf-toolbar"
      >
        <span className="tabular-nums" data-testid="pdf-page-indicator">
          Page {page} of {doc.numPages}
        </span>
        <span aria-hidden>·</span>
        <span className="truncate">{formatFileSize(size)}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={zoom <= minZoom + 1e-6}
          onClick={() => setZoom((z) => stepZoom(z, -1))}
        >
          <Minus strokeWidth={1.5} />
        </Button>
        <button
          type="button"
          className="min-w-10 rounded-control px-1 text-center tabular-nums transition-colors hover:text-text-primary"
          aria-label="Fit to width"
          title="Fit to width"
          onClick={() => setZoom(1)}
          data-testid="pdf-zoom"
        >
          {Math.abs(zoom - 1) < 1e-6 ? 'Fit' : `${Math.round(zoom * 100)}%`}
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={zoom >= maxZoom - 1e-6}
          onClick={() => setZoom((z) => stepZoom(z, 1))}
        >
          <Plus strokeWidth={1.5} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open in default app"
          title="Open in default app"
          onClick={() => void openInDefaultApp(path)}
        >
          <ExternalLink strokeWidth={1.5} />
        </Button>
      </div>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto bg-bg-2"
        onScroll={trackPage}
        data-testid="pdf-scroller"
      >
        <div className="flex w-max min-w-full flex-col items-center gap-3" style={{ padding: PAD }}>
          {available > 0 &&
            pages.map((n) => (
              <PdfPage
                key={n}
                doc={doc}
                pageNumber={n}
                width={width}
                aspect={aspects[n] ?? firstAspect}
                scroller={scroller}
                onAspect={onAspect}
                register={(el) => (pageEls.current[n - 1] = el)}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One page: a placeholder of the page's size, and once it's near the view
 * its canvas (redrawn on zoom, dropped when far away) under pdf.js's text
 * layer (built once, then scaled by `--total-scale-factor`), so its text can
 * be selected and copied. The element carries `data-page` and its
 * `.textLayer` keeps the PDF's own text in content order: what a comment
 * anchored to a quote on a page would look for.
 */
function PdfPage({
  doc,
  pageNumber,
  width,
  aspect,
  scroller,
  onAspect,
  register,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  aspect: number;
  scroller: RefObject<HTMLDivElement | null>;
  onAspect: (pageNumber: number, aspect: number) => void;
  register: (el: HTMLDivElement | null) => void;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [pdfPage, setPdfPage] = useState<PDFPageProxy | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [hasText, setHasText] = useState(false);
  const drawnRef = useRef(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), {
      root: scroller.current,
      rootMargin: '150% 0px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scroller]);

  // The page itself, the first time it comes near.
  useEffect(() => {
    if (!near || pdfPage) return;
    let cancelled = false;
    doc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        onAspect(pageNumber, base.height / base.width);
        setPdfPage(page);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, near, pdfPage, onAspect]);

  // The canvas: drawn while near (sharp again shortly after a zoom), given back when far.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!near) {
      canvas.width = 0;
      canvas.height = 0;
      drawnRef.current = false;
      setDrawn(false);
      return;
    }
    if (!pdfPage) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    const timer = setTimeout(
      () =>
        void (async () => {
          try {
            const base = pdfPage.getViewport({ scale: 1 });
            const wanted = (width / base.width) * (window.devicePixelRatio || 1);
            const area = base.width * base.height * wanted * wanted;
            const scale =
              area > MAX_CANVAS_PIXELS ? wanted * Math.sqrt(MAX_CANVAS_PIXELS / area) : wanted;
            const viewport = pdfPage.getViewport({ scale });
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            task = pdfPage.render({ canvas, viewport });
            await task.promise;
            if (cancelled) return;
            drawnRef.current = true;
            setDrawn(true);
          } catch {
            // Cancelled (scrolled away, zoomed again), or a page pdf.js couldn't draw: it stays blank.
          }
        })(),
      drawnRef.current ? REDRAW_DELAY_MS : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [pdfPage, width, near]);

  // The text layer: laid out once at scale 1; the page's `--total-scale-factor` sizes it.
  useEffect(() => {
    const container = textRef.current;
    if (!pdfPage || !container) return;
    let cancelled = false;
    let finished = false;
    let layer: { done: Promise<void>; cancel: () => void } | null = null;
    void import('./pdf-document')
      .then(async ({ buildTextLayer }) => {
        if (cancelled) return;
        layer = buildTextLayer(pdfPage, container, pdfPage.getViewport({ scale: 1 }));
        await layer.done;
        finished = true;
        if (!cancelled) setHasText(true);
      })
      .catch(() => {
        // No text (a scan), or cancelled: the page is still drawn, just not selectable.
      });
    return () => {
      cancelled = true;
      if (!finished) layer?.cancel();
    };
  }, [pdfPage]);

  const baseWidth = pdfPage?.getViewport({ scale: 1 }).width ?? null;
  return (
    <div
      ref={(el) => {
        holder.current = el;
        register(el);
      }}
      className="shrink-0 overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-black/10"
      style={
        {
          position: 'relative',
          width,
          height: Math.round(width * aspect),
          ...(baseWidth
            ? {
                '--total-scale-factor': width / baseWidth,
                '--scale-round-x': '1px',
                '--scale-round-y': '1px',
              }
            : {}),
        } as CSSProperties
      }
      data-testid="pdf-page"
      data-page={pageNumber}
      data-drawn={drawn ? 'true' : 'false'}
      data-text={hasText ? 'ready' : 'none'}
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%' }}
      />
      {/* pdf.js fills this; React never renders children into it. */}
      <div ref={textRef} className="textLayer" data-testid="pdf-text-layer" />
    </div>
  );
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1]!, Math.max(ZOOM_STEPS[0], zoom));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
