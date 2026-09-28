import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAFETY_TICK_MS, startRelocator } from './pin-relocator';

// Timers and animation frames are fakes: a frame is 16ms of fake time.

let frames: (() => void)[] = [];
const raf = (cb: () => void) => frames.push(cb);
const flushFrame = async () => {
  const now = frames;
  frames = [];
  for (const cb of now) cb();
  await vi.advanceTimersByTimeAsync(0);
};

function setup(locate = vi.fn(async () => {})) {
  let moved: (() => void) | null = null;
  const relocator = startRelocator({
    locate,
    subscribe: (cb) => {
      moved = cb;
      return () => {
        moved = null;
      };
    },
    raf,
    caf: () => {
      frames = [];
    },
  });
  return { relocator, locate, signal: () => moved?.(), subscribed: () => moved !== null };
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
});
afterEach(() => vi.useRealTimers());

describe('startRelocator', () => {
  it('looks once at the start, then nothing while the page is still (until the safety tick)', async () => {
    const { locate } = setup();
    await flushFrame();
    expect(locate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS - 10);
    await flushFrame();
    expect(locate).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(0);
  });

  it('looks again on "moved", once per animation frame however many signals arrive', async () => {
    const { locate, signal } = setup();
    await flushFrame();
    signal();
    signal();
    signal();
    await flushFrame();
    expect(locate).toHaveBeenCalledTimes(2);
    signal();
    await flushFrame();
    expect(locate).toHaveBeenCalledTimes(3);
    await flushFrame();
    expect(locate).toHaveBeenCalledTimes(3);
  });

  it('keeps a safety tick for a signal that never came', async () => {
    const { locate } = setup();
    await flushFrame();
    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS);
    await flushFrame();
    expect(locate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS);
    await flushFrame();
    expect(locate).toHaveBeenCalledTimes(3);
  });

  it('never runs two looks at once: a signal during one runs one more after it', async () => {
    let finish!: () => void;
    const locate = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { signal } = setup(locate);
    await flushFrame();
    signal();
    await flushFrame();
    signal();
    await flushFrame();
    expect(locate).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    await flushFrame();
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it('stops listening, ticking and looking when stopped', async () => {
    const { relocator, locate, signal, subscribed } = setup();
    await flushFrame();
    relocator.stop();
    expect(subscribed()).toBe(false);
    signal();
    relocator.poke();
    await vi.advanceTimersByTimeAsync(SAFETY_TICK_MS * 3);
    await flushFrame();
    expect(locate).toHaveBeenCalledOnce();
  });

  it('poke looks again (the panel resized)', async () => {
    const { relocator, locate } = setup();
    await flushFrame();
    relocator.poke();
    await flushFrame();
    expect(locate).toHaveBeenCalledTimes(2);
  });
});
