import { describe, expect, it } from 'vitest';
import { LatestRequestGate } from './latest-request-gate';

describe('LatestRequestGate', () => {
  it('accepts only the most recently started request', () => {
    const gate = new LatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('invalidates outstanding requests when navigation leaves the flow', () => {
    const gate = new LatestRequestGate();
    const request = gate.begin();

    gate.invalidate();

    expect(gate.isCurrent(request)).toBe(false);
  });
});
