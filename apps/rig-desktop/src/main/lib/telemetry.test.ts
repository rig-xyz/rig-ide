import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getVersion: vi.fn(() => '1.0.0'),
  kvSet: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: mocks.getVersion,
    isPackaged: false,
  },
}));

vi.mock('@main/db/kv', () => ({
  KV: class {
    get = vi.fn(async () => null);
    set = mocks.kvSet;
    del = vi.fn(async () => undefined);
  },
}));

const { telemetryService, __testing } = await import('./telemetry');
const { errorName, stackFrames, fingerprint } = __testing;

describe('error fingerprinting (main/lib/telemetry.ts)', () => {
  it('errorName reads a real Error, a plain {name} object, or falls back to UnknownError', () => {
    expect(errorName(new Error('boom'))).toBe('Error');
    expect(errorName({ name: 'TypeError' })).toBe('TypeError');
    expect(errorName(null)).toBe('UnknownError');
    expect(errorName('a string, not an error')).toBe('UnknownError');
  });

  it('stackFrames strips directory paths down to basename:function, capped at 3', () => {
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      '    at doThing (/Users/dylan/Code/rigdash/apps/rig-desktop/src/main/rig/files.ts:10:5)',
      '    at Object.<anonymous> (/Users/dylan/Code/rigdash/node_modules/foo/index.js:2:1)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at neverReached (/some/other/path.js:1:1)',
    ].join('\n');

    const frames = stackFrames(error);

    expect(frames).toEqual([
      'files.ts:doThing',
      'index.js:Object.<anonymous>',
      'task_queues:processTicksAndRejections',
    ]);
    for (const frame of frames) {
      expect(frame).not.toMatch(/[\\/]/);
      expect(frame).not.toContain('Users');
      expect(frame).not.toContain('node_modules');
    }
  });

  it('stackFrames is empty for anything that is not a real Error — e.g. the renderer\'s content-free report', () => {
    expect(stackFrames({ name: 'TypeError' })).toEqual([]);
    expect(stackFrames(null)).toEqual([]);
  });

  it('fingerprint is stable for the same kind/name/frames and never depends on the message', () => {
    const a = new Error('message A — super secret');
    a.stack = 'Error: message A — super secret\n    at fn (/a/b/c.ts:1:1)';
    const b = new Error('a totally different secret message');
    b.stack = 'Error: a totally different secret message\n    at fn (/a/b/c.ts:1:1)';

    const fpA = fingerprint('main-uncaught', errorName(a), stackFrames(a));
    const fpB = fingerprint('main-uncaught', errorName(b), stackFrames(b));

    expect(fpA).toBe(fpB);
    expect(fpA).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a renderer report (no stack) fingerprints as exactly sha256(kind + errorName)', () => {
    const fp = fingerprint('renderer', 'TypeError', []);
    const expected = createHash('sha256').update('rendererTypeError').digest('hex').slice(0, 16);
    expect(fp).toBe(expected);
  });
});

describe('telemetryService.setEnabled / isUserEnabled', () => {
  afterEach(() => {
    mocks.kvSet.mockClear();
  });

  it('defaults to enabled', () => {
    expect(telemetryService.isUserEnabled()).toBe(true);
  });

  it('flips isUserEnabled immediately and persists the choice to KV', () => {
    telemetryService.setEnabled(false);
    expect(telemetryService.isUserEnabled()).toBe(false);
    expect(mocks.kvSet).toHaveBeenCalledWith('enabled', 'false');

    telemetryService.setEnabled(true);
    expect(telemetryService.isUserEnabled()).toBe(true);
    expect(mocks.kvSet).toHaveBeenCalledWith('enabled', 'true');
  });
});
