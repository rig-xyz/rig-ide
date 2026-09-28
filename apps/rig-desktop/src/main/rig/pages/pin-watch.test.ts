import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORWARD_EVERY_MS, stopAllPinWatches, throttle, watchPins, type WatchedContents } from './pin-watch';

// A fake panel page: its WebContents events, its frames, and what was injected where.

function fakePage(id = 1) {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const on = (name: string, fn: (...args: unknown[]) => void) => {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name)!.add(fn);
  };
  const child = { executeJavaScript: vi.fn(async () => true) };
  const top = { executeJavaScript: vi.fn(async () => true), framesInSubtree: [] as { executeJavaScript: (code: string) => Promise<unknown> }[] };
  top.framesInSubtree = [top, child];
  const wc = {
    id,
    isDestroyed: () => false,
    on: vi.fn((name: string, fn: (...args: unknown[]) => void) => (on(name, fn), wc)),
    once: vi.fn((name: string, fn: (...args: unknown[]) => void) => (on(name, fn), wc)),
    off: vi.fn((name: string, fn: (...args: unknown[]) => void) => (handlers.get(name)?.delete(fn), wc)),
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => true),
    mainFrame: top,
  };
  const emit = (name: string, ...args: unknown[]) => {
    for (const fn of [...(handlers.get(name) ?? [])]) fn(...args);
  };
  const marker = () => {
    const code = wc.executeJavaScriptInIsolatedWorld.mock.calls[0]![1][0]!.code;
    return /"(rig-pin-moved:[0-9a-f]+)"/.exec(code)![1]!;
  };
  return { wc: wc as unknown as WatchedContents, raw: wc, top, child, emit, marker, handlers };
}

afterEach(() => {
  stopAllPinWatches();
  vi.useRealTimers();
});

describe('watchPins', () => {
  it("injects the watcher: the top frame in rig's own world, child frames in theirs, and again as frames load", () => {
    const page = fakePage();
    watchPins(page.wc, () => {});
    expect(page.raw.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
    expect(page.raw.executeJavaScriptInIsolatedWorld.mock.calls[0]![0]).not.toBe(0);
    expect(page.top.executeJavaScript).not.toHaveBeenCalled();
    expect(page.child.executeJavaScript).toHaveBeenCalledOnce();
    page.emit('did-frame-finish-load');
    expect(page.raw.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    expect(page.child.executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it('forwards only its own nonce, throttled', () => {
    vi.useFakeTimers();
    const page = fakePage();
    const moved = vi.fn();
    watchPins(page.wc, moved);
    const marker = page.marker();
    page.emit('console-message', { message: 'rig-pin-moved:0000' });
    page.emit('console-message', { message: `x ${marker}` });
    page.emit('console-message', { message: 'hello' });
    expect(moved).not.toHaveBeenCalled();
    page.emit('console-message', { message: marker });
    page.emit('console-message', { message: marker });
    page.emit('console-message', { message: marker });
    expect(moved).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(FORWARD_EVERY_MS);
    expect(moved).toHaveBeenCalledTimes(2);
  });

  it('uses a different nonce per page, and watches a page once', () => {
    const a = fakePage(1);
    const b = fakePage(2);
    watchPins(a.wc, () => {});
    watchPins(a.wc, () => {});
    watchPins(b.wc, () => {});
    expect(a.raw.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
    expect(a.marker()).not.toBe(b.marker());
  });

  it('stops when the page goes away', () => {
    const page = fakePage();
    const moved = vi.fn();
    watchPins(page.wc, moved);
    const marker = page.marker();
    page.emit('destroyed');
    page.emit('console-message', { message: marker });
    expect(moved).not.toHaveBeenCalled();
    watchPins(page.wc, moved);
    expect(page.raw.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  });
});

describe('throttle', () => {
  it('runs the first call at once and one trailing call per window', () => {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const clock = { now: () => now, setTimeout: (fn: () => void, ms: number) => timers.push({ at: now + ms, fn }) };
    const fn = vi.fn();
    const t = throttle(fn, 50, clock);
    t();
    t();
    t();
    expect(fn).toHaveBeenCalledOnce();
    expect(timers).toHaveLength(1);
    now = 50;
    timers.shift()!.fn();
    expect(fn).toHaveBeenCalledTimes(2);
    now = 200;
    t();
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
