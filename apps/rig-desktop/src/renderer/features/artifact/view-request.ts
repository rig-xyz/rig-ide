import { useEffect, useRef } from 'react';
import { setPreviewMode, type PreviewMode } from './preview-mode-memory';

/**
 * Ask an open (or about to open) file or page to show something: a mode
 * (Browser for an html file), a passage or a line to scroll to, or a
 * page's comment thread. Keyed by
 * what the view shows: a file's absolute path, a page's link. The view
 * takes the request when it's mounted, or as soon as it mounts; one the
 * view never picks up lapses.
 */

export type ViewRequest = {
  mode?: PreviewMode;
  passage?: string;
  line?: number;
  /** A page's comment thread to open, by its first comment's id or a reply's. */
  thread?: string;
};

const LAPSES_AFTER_MS = 60_000;

const pending = new Map<string, { request: ViewRequest; at: number }>();
const listeners = new Map<string, (request: ViewRequest) => void>();

export function requestView(key: string, request: ViewRequest): void {
  const listener = listeners.get(key);
  if (listener) {
    listener(request);
    return;
  }
  pending.set(key, { request, at: Date.now() });
}

/** An html file opens as a working page: Browser mode, from its first render if it isn't open yet. */
export function requestBrowserMode(absPath: string, extra: Omit<ViewRequest, 'mode'> = {}): void {
  setPreviewMode(absPath, 'browser');
  requestView(absPath, { mode: 'browser', ...extra });
}

/** Hands `onRequest` every request for `key`, the one waiting first. */
export function useViewRequest(key: string, onRequest: (request: ViewRequest) => void): void {
  const handler = useRef(onRequest);
  handler.current = onRequest;
  useEffect(() => {
    const listener = (request: ViewRequest) => handler.current(request);
    listeners.set(key, listener);
    const waiting = pending.get(key);
    pending.delete(key);
    if (waiting && Date.now() - waiting.at <= LAPSES_AFTER_MS) listener(waiting.request);
    return () => {
      if (listeners.get(key) === listener) listeners.delete(key);
    };
  }, [key]);
}

/** Test-only: module state outlives a test. */
export function resetViewRequestsForTests(): void {
  pending.clear();
  listeners.clear();
}
