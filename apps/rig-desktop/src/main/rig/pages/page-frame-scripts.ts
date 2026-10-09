/**
 * Code that runs INSIDE a page's frames, injected per call with
 * `executeJavaScript` (nothing is left behind in the page). Each function is
 * self-contained: it's serialized with `toString()`, so it may not reference
 * imports, module scope or other functions here.
 *
 * Pages like claude.ai's design canvas put the content one cross-origin frame
 * down (claudeusercontent.com), with each board a same-origin srcdoc frame
 * inside that, on a pan/zoom stage. These functions handle everything within
 * one origin: they descend into same-origin frames directly and fold CSS
 * transforms in through getBoundingClientRect. A cross-origin frame stops the
 * walk and is reported back, so the main process continues in that frame.
 * Proven on the real canvas in the pins spike (rig-experiments-spaces/artifact-pins).
 */

import type { PageAnchor } from '@shared/spaces/pages';

export type { PageAnchor, PageAnchorHop } from '@shared/spaces/pages';

export type FrameHit =
  | (Omit<PageAnchor, 'xo'> & { crossOrigin?: undefined })
  | { crossOrigin: { origin: string; index: number }; x: number; y: number }
  | null;

export interface FrameLocate {
  found: boolean;
  why?: string;
  how?: 'path' | 'text';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/**
 * `hit` → an anchor for what's under (x, y) in this frame's viewport;
 * `locate` → where an anchor is now; `xoFrame` → the content-box geometry of a
 * cross-origin child frame, to map coordinates through it.
 */
export function framePin(op: 'hit' | 'locate' | 'xoFrame', arg: any): any {
  const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const iframesOf = (doc: Document) => [...doc.querySelectorAll('iframe')];
  const sameOriginDoc = (f: HTMLIFrameElement): Document | null => {
    try {
      return f.contentDocument || null;
    } catch {
      return null;
    }
  };
  const textOf = (el: Element) => norm((el as HTMLElement).innerText !== undefined ? (el as HTMLElement).innerText : el.textContent).slice(0, 160);
  const boardSig = (f: HTMLIFrameElement) => {
    const d = sameOriginDoc(f);
    return d && d.body ? norm(d.body.innerText).slice(0, 200) : null;
  };
  const overlap = (a: string | null, b: string | null) => {
    const A = new Set((a || '').toLowerCase().split(/\W+/).filter(Boolean));
    const B = new Set((b || '').toLowerCase().split(/\W+/).filter(Boolean));
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    return A.size && B.size ? n / Math.min(A.size, B.size) : 0;
  };
  const originOf = (f: HTMLIFrameElement) => {
    try {
      return new URL(f.src, location.href).origin;
    } catch {
      return null;
    }
  };
  // How an iframe maps its inside onto its parent: content box origin + scale.
  const geometry = (f: HTMLIFrameElement) => {
    const r = f.getBoundingClientRect();
    const sx = r.width / (f.offsetWidth || 1);
    const sy = r.height / (f.offsetHeight || 1);
    return { left: r.left + f.clientLeft * sx, top: r.top + f.clientTop * sy, sx, sy };
  };
  const cssPath = (el: Element) => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e.nodeType === 1 && e !== e.ownerDocument.documentElement; e = e.parentElement) {
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      parts.unshift(e.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
    }
    return parts.join('>');
  };

  if (op === 'xoFrame') {
    const f = iframesOf(document).filter((c) => originOf(c) === arg.origin)[arg.index];
    return f ? geometry(f) : null;
  }

  if (op === 'hit') {
    let doc: Document = document;
    let x: number = arg.x;
    let y: number = arg.y;
    const hops: { index: number; sig: string | null }[] = [];
    for (;;) {
      // A canvas lays transparent layers (selection, loading) over its
      // boards: when a frame is anywhere under the point, go into it.
      const stack = doc.elementsFromPoint(x, y);
      const el = stack.find((e) => e.tagName === 'IFRAME') || stack[0];
      if (!el) return null;
      if (el.tagName === 'IFRAME') {
        const f = el as HTMLIFrameElement;
        const g = geometry(f);
        const lx = (x - g.left) / g.sx;
        const ly = (y - g.top) / g.sy;
        const inner = sameOriginDoc(f);
        if (!inner) {
          if (hops.length) return null; // a cross-origin frame inside a board: not supported
          const origin = originOf(f);
          if (!origin) return null;
          const index = iframesOf(doc).filter((c) => originOf(c) === origin).indexOf(f);
          return { crossOrigin: { origin, index }, x: lx, y: ly };
        }
        hops.push({ index: iframesOf(doc).indexOf(f), sig: boardSig(f) });
        doc = inner;
        x = lx;
        y = ly;
        continue;
      }
      const r = el.getBoundingClientRect();
      return { hops, path: cssPath(el), tag: el.tagName.toLowerCase(), text: textOf(el), fx: (x - r.left) / (r.width || 1), fy: (y - r.top) / (r.height || 1) };
    }
  }

  if (op === 'locate') {
    let doc: Document = document;
    const chain: HTMLIFrameElement[] = [];
    for (const hop of arg.hops as { index: number; sig: string | null }[]) {
      const frames = iframesOf(doc);
      // Same board: exact words, else the most similar board, else the one
      // holding the pinned text, else the same position.
      let f = frames.find((c) => hop.sig && boardSig(c) === hop.sig);
      if (!f && hop.sig) {
        const scored = frames.map((c) => [c, overlap(hop.sig, boardSig(c))] as const).sort((a, b) => b[1] - a[1]);
        if (scored[0] && scored[0][1] >= 0.6) f = scored[0][0];
      }
      if (!f && arg.text) {
        f = frames.find((c) => {
          const d = sameOriginDoc(c);
          return !!d && [...d.querySelectorAll(arg.tag)].some((e) => textOf(e) === arg.text);
        });
      }
      if (!f) f = frames[hop.index];
      const inner = f && sameOriginDoc(f);
      if (!f || !inner) return { found: false, why: 'board gone' };
      chain.push(f);
      doc = inner;
    }
    let el: Element | null = null;
    let how: 'path' | 'text' | null = null;
    try {
      el = doc.querySelector(arg.path);
    } catch {}
    if (el && el.tagName.toLowerCase() === arg.tag && (!arg.text || textOf(el) === arg.text)) how = 'path';
    else {
      el = arg.text ? [...doc.querySelectorAll(arg.tag)].find((c) => textOf(c) === arg.text) || null : null;
      if (el) how = 'text';
    }
    if (!el) return { found: false, why: 'element gone' };
    const r = el.getBoundingClientRect();
    let x = r.left + arg.fx * r.width;
    let y = r.top + arg.fy * r.height;
    let w = r.width;
    let h = r.height;
    for (let i = chain.length - 1; i >= 0; i--) {
      const g = geometry(chain[i]!);
      x = g.left + x * g.sx;
      y = g.top + y * g.sy;
      w *= g.sx;
      h *= g.sy;
    }
    return { found: true, how, x, y, w, h };
  }
  return null;
}

export interface BoardInfo {
  i: number;
  title: string;
  onScreen: boolean;
  text?: string;
}

/** Every same-origin board in this frame: index, title, on screen, and (optionally) its text. */
export function frameBoards(withText: boolean): BoardInfo[] {
  const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
  const out: BoardInfo[] = [];
  document.querySelectorAll('iframe').forEach((f, i) => {
    let d: Document | null = null;
    try {
      d = f.contentDocument;
    } catch {}
    if (!d || !d.body) return;
    const text = (d.body.innerText || '').trim();
    if (!text) return;
    const r = f.getBoundingClientRect();
    out.push({
      i,
      title: norm(text).slice(0, 80),
      onScreen: r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight,
      ...(withText ? { text } : {}),
    });
  });
  return out;
}

export interface BoardSnapshot {
  i: number;
  title: string;
  html: string;
  w: number;
  h: number;
  el: { x: number; y: number; width: number; height: number } | null;
}

/**
 * One board as static HTML at its own size (scripts removed), plus where an
 * element sits in it: the board by index, words in its text, or a pin's board
 * signature; the element by CSS path, or the smallest one holding a phrase.
 * Re-rendering a board at full size is what keeps screenshots legible when a
 * canvas is zoomed out to fit.
 */
export function frameBoardSnapshot(q: { i?: number; sig?: string | null; words?: string; index?: number; path?: string; text?: string }): BoardSnapshot | null {
  const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const frames = [...document.querySelectorAll('iframe')];
  const docOf = (f: HTMLIFrameElement): Document | null => {
    try {
      return f.contentDocument;
    } catch {
      return null;
    }
  };
  const textOf = (c: HTMLIFrameElement) => {
    const d = docOf(c);
    return d && d.body ? norm(d.body.innerText) : '';
  };
  // A pin with no board (no sig, no index) is on this frame's own document.
  const ownPin = q.path !== undefined && q.sig == null && q.index === undefined && q.i === undefined && q.words === undefined;
  let f: HTMLIFrameElement | undefined;
  if (!ownPin) {
    if (q.i !== undefined) f = frames[q.i];
    if (!f && q.sig) f = frames.find((c) => textOf(c).startsWith(norm(q.sig!).slice(0, 40)));
    if (!f && q.words) f = frames.find((c) => textOf(c).includes(norm(q.words!)));
    if (!f && q.text) f = frames.find((c) => textOf(c).includes(norm(q.text!)));
    if (!f && q.index !== undefined) f = frames[q.index];
  }
  // No board asked for and none holding the text: the page itself, as one board.
  const own = !f && (ownPin || (q.i === undefined && q.words === undefined && q.sig == null && q.index === undefined));
  const d = own ? document : f && docOf(f);
  if ((!own && !f) || !d || !d.body) return null;
  let el: Element | null = null;
  if (q.path) {
    try {
      el = d.querySelector(q.path);
    } catch {}
  }
  if (!el && q.text) {
    const hits = [...d.body.querySelectorAll('*')].filter((e) => norm(e.textContent || '').includes(norm(q.text!)));
    el = hits[hits.length - 1] || null;
  }
  if (own && !el) return null;
  const r = el && el.getBoundingClientRect();
  const clone = d.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script').forEach((s) => s.remove());
  if (own && !clone.querySelector('base')) {
    // Relative styles and images still load once the copy is rendered from a data: link.
    const base = d.createElement('base');
    base.href = location.href;
    clone.querySelector('head')?.prepend(base);
  }
  return {
    i: own ? -1 : frames.indexOf(f!),
    title: (d.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    html: '<!doctype html>' + clone.outerHTML,
    w: own ? d.documentElement.clientWidth : f!.clientWidth,
    h: own ? Math.min(Math.max(d.documentElement.scrollHeight, innerHeight), 10000) : f!.clientHeight,
    el: r ? { x: r.left + d.defaultView!.scrollX, y: r.top + d.defaultView!.scrollY, width: r.width, height: r.height } : null,
  };
}

/**
 * A small watcher left in a panel page's frame, so pins move with the page
 * instead of being looked for every few milliseconds: scrolling (any
 * scroller, captured), resizing, pinch-zoom (visualViewport) and DOM
 * changes (a canvas's pan/zoom is a style change) each say "moved" by
 * logging `marker` (a per-page nonce main listens for), at most once per
 * `every` ms. Same-origin child frames (a canvas's boards) are watched too.
 * Idempotent per frame and world. It carries nothing but the marker: a page
 * that copies it can only make rig look for its pins again.
 */
export function frameWatch(marker: string, every: number): boolean {
  const w = window as unknown as { __rigPinWatch?: string };
  if (w.__rigPinWatch === marker) return false;
  w.__rigPinWatch = marker;
  const log = console.debug.bind(console);
  let last = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const signal = () => {
    const now = Date.now();
    if (now - last >= every) {
      last = now;
      log(marker);
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        last = Date.now();
        log(marker);
      }, every - (now - last));
    }
  };
  const watched = new WeakSet<Document>();
  const watch = (doc: Document) => {
    if (watched.has(doc)) return;
    watched.add(doc);
    const win = doc.defaultView;
    doc.addEventListener('scroll', signal, { capture: true, passive: true });
    win?.addEventListener('resize', signal, { passive: true });
    win?.visualViewport?.addEventListener('resize', signal, { passive: true });
    win?.visualViewport?.addEventListener('scroll', signal, { passive: true });
    new MutationObserver(() => {
      signal();
      frames(doc);
    }).observe(doc.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
    frames(doc);
  };
  const frames = (doc: Document) => {
    for (const f of Array.from(doc.querySelectorAll('iframe'))) {
      try {
        if (f.contentDocument?.documentElement) watch(f.contentDocument);
      } catch {
        // Cross-origin: main watches that frame itself.
      }
    }
  };
  watch(document);
  return true;
}

/** `(fn)(args)` source for executeJavaScript. */
export function frameCall(fn: (...args: any[]) => unknown, ...args: unknown[]): string {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
}
