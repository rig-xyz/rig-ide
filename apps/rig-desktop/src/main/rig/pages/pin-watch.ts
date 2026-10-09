import { randomBytes } from 'node:crypto';
import type { WebContents } from 'electron';
import { frameCall, frameWatch } from './page-frame-scripts';

/**
 * Event-driven page pins, main side. A panel page gets a small watcher in
 * each of its frames (`frameWatch`) that logs a per-page nonce when the page
 * scrolls, resizes, zooms or changes; main hears it as a `console-message`
 * on the page's WebContents and forwards a throttled "moved" to the
 * renderer, which looks for the pins again.
 *
 * Why the console: a `<webview>` guest gets no preload here (they're
 * stripped for safety, `webview-security.ts`), so there's no IPC in the
 * page. The top frame's watcher runs in an isolated world, where the page
 * can neither see the nonce nor stub `console.debug`; child frames (a
 * canvas's cross-origin content) can only be reached in their own world, so
 * a page could replay that marker. All a replay does is make rig look for
 * the pins again, at most every `FORWARD_EVERY_MS`, and nothing is read from
 * the message but whether it equals the nonce.
 */

/** An isolated world of rig's own for the top frame's watcher (0 is the page's, 999 Electron's). */
const WATCH_WORLD_ID = 1042;
/** How often a frame may say "moved". */
export const SIGNAL_EVERY_MS = 80;
/** How often main passes "moved" on to the renderer. */
export const FORWARD_EVERY_MS = 50;

/** Leading and trailing: the first call runs at once, calls in the window after it run once at its end. */
export function throttle(fn: () => void, ms: number, clock: { now(): number; setTimeout(f: () => void, ms: number): unknown } = { now: Date.now, setTimeout }) {
  let last = -Infinity;
  let pending = false;
  return () => {
    const now = clock.now();
    if (now - last >= ms) {
      last = now;
      fn();
      return;
    }
    if (pending) return;
    pending = true;
    clock.setTimeout(() => {
      pending = false;
      last = clock.now();
      fn();
    }, ms - (now - last));
  };
}

type Frame = { executeJavaScript(code: string): Promise<unknown> };

/** The parts of a WebContents the watch uses (a fake in tests). */
export type WatchedContents = Pick<WebContents, 'id' | 'isDestroyed' | 'on' | 'off' | 'once' | 'executeJavaScriptInIsolatedWorld'> & {
  /** The top frame; `framesInSubtree` includes it. */
  mainFrame: Frame & { framesInSubtree: Frame[] };
};

const watching = new Map<number, () => void>();

/** Starts watching a panel page (once per page); `onMoved` is called throttled until the page goes away. */
export function watchPins(wc: WatchedContents, onMoved: () => void): void {
  if (watching.has(wc.id)) return;
  const marker = `rig-pin-moved:${randomBytes(12).toString('hex')}`;
  const code = frameCall(frameWatch, marker, SIGNAL_EVERY_MS);
  const top = wc.mainFrame;
  const inject = () => {
    if (wc.isDestroyed()) return;
    void wc.executeJavaScriptInIsolatedWorld(WATCH_WORLD_ID, [{ code }]).catch(() => {});
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (frame !== top) void frame.executeJavaScript(code).catch(() => {});
    }
  };
  const forward = throttle(onMoved, FORWARD_EVERY_MS);
  const onConsole = (details: { message?: string }) => {
    if (details?.message === marker) forward();
  };
  // A document that just loaded (a reload after the file was written, a
  // frame that loads later) has its new layout already: the watcher only
  // hears what changes after it, so say "moved" once now.
  const onLoad = () => {
    inject();
    forward();
  };
  const stop = () => {
    wc.off('console-message', onConsole as never);
    wc.off('did-frame-finish-load', onLoad as never);
    watching.delete(wc.id);
  };
  wc.on('console-message', onConsole as never);
  // Every new document (a navigation, a frame that loads later) gets its watcher.
  wc.on('did-frame-finish-load', onLoad as never);
  wc.once('destroyed', stop as never);
  watching.set(wc.id, stop);
  inject();
}

/** Tests only. */
export function stopAllPinWatches(): void {
  for (const stop of [...watching.values()]) stop();
}
