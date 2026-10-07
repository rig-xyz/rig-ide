import { describe, expect, it, vi } from 'vitest';
import type { PageAnchor } from '@shared/spaces/pages';
import { createPinMissLog, pageForLog } from './pin-miss-log';

const anchor: PageAnchor = {
  xo: [{ origin: 'https://abc.claudeusercontent.com', index: 0 }],
  hops: [{ index: 2, sig: 'Revenue by quarter' }],
  path: 'body>td:nth-of-type(1)',
  tag: 'td',
  text: 'Secret figure 398',
  fx: 0.5,
  fy: 0.5,
};
const PAGE = 'https://claude.ai/public/artifacts/x?token=abc#top';

describe('pageForLog', () => {
  it('keeps the origin and path, never the query or hash', () => {
    expect(pageForLog(PAGE)).toBe('https://claude.ai/public/artifacts/x');
    expect(pageForLog('not a url')).toBe('unknown');
  });
});

describe('createPinMissLog', () => {
  it("logs why a pin wasn't placed, with the anchor's frames and tag but not its text", () => {
    const write = vi.fn();
    createPinMissLog(write)(PAGE, { id: 'p1', anchor }, 'element gone');
    expect(write).toHaveBeenCalledWith('Rig pages: a pin was not placed', {
      page: 'https://claude.ai/public/artifacts/x',
      pin: 'p1',
      why: 'element gone',
      frameOrigins: ['https://abc.claudeusercontent.com'],
      boardHops: 1,
      tag: 'td',
    });
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/Secret|Revenue|token/);
  });

  it('logs once per page, pin and reason across relocate ticks', () => {
    const write = vi.fn();
    const miss = createPinMissLog(write);
    miss(PAGE, { id: 'p1', anchor }, 'element gone');
    miss(PAGE, { id: 'p1', anchor }, 'element gone');
    miss('https://claude.ai/public/artifacts/x?other=1', { id: 'p1', anchor }, 'element gone');
    expect(write).toHaveBeenCalledTimes(1);
    miss(PAGE, { id: 'p1', anchor }, 'board gone');
    miss(PAGE, { id: 'p2', anchor }, 'element gone');
    miss('https://claude.ai/public/artifacts/y', { id: 'p1', anchor }, 'element gone');
    expect(write).toHaveBeenCalledTimes(4);
  });

  it('names a miss without a reason as an error', () => {
    const write = vi.fn();
    createPinMissLog(write)(PAGE, { id: 'p1', anchor }, undefined);
    expect(write.mock.calls[0]![1]).toMatchObject({ why: 'error' });
  });
});
