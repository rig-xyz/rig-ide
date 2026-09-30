import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PageViewport,
  type PDFDocumentLoadingTask,
  type PDFPageProxy,
} from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './pdf-text-layer.css';

/**
 * pdf.js, loaded only when a PDF is opened (`pdf-artifact.tsx` imports this
 * module dynamically, so the viewer and its worker stay out of the app's
 * startup bundle).
 *
 * The PDF may come from anyone in the space, so it's treated as untrusted:
 * it's parsed in pdf.js's own Web Worker (no DOM, no preload bridge), and
 * shown as a canvas plus pdf.js's text layer (its text as transparent,
 * selectable spans set with `textContent`, never markup). Nothing in it
 * runs: pdf.js's core API never executes a PDF's JavaScript (that needs the
 * separate scripting sandbox, which isn't loaded), XFA forms are off, and no
 * annotation or link layer is built, so the document can't put markup or
 * navigation into the page. pdf.js 6 has no `eval`-based font path at all
 * (the CVE-2024-4367 class). Each document gets its own worker, ended by
 * `destroy()`.
 */

GlobalWorkerOptions.workerSrc = workerSrc;

export function openPdf(data: Uint8Array): PDFDocumentLoadingTask {
  return getDocument({ data, enableXfa: false, stopAtErrors: false });
}

/**
 * A page's text, as pdf.js lays it out over the canvas, into `container`
 * (a `.textLayer` div inside the page element, which sets
 * `--total-scale-factor`). The spans keep the text exactly as the PDF has it,
 * in content order — what a comment would quote. Laid out once at `viewport`;
 * a zoom only changes the page's `--total-scale-factor`.
 */
export function buildTextLayer(
  page: PDFPageProxy,
  container: HTMLElement,
  viewport: PageViewport
): { done: Promise<void>; cancel: () => void } {
  const layer = new TextLayer({
    textContentSource: page.streamTextContent({
      includeMarkedContent: true,
      disableNormalization: true,
    }),
    container,
    viewport,
  });
  const done = layer.render().then(() => {
    // Where a selection dragged past the last run lands, as in pdf.js's own viewer.
    const end = document.createElement('div');
    end.className = 'endOfContent';
    container.append(end);
  });
  return { done, cancel: () => layer.cancel() };
}

export type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
