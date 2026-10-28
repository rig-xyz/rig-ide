import { describe, expect, it } from 'vitest';
import { arriveHome, clearHomeArrival, homeArrival, railIdFor } from './arrival';

describe("Home's arrival from the first run", () => {
  it('waits for Home until it has shown, then is gone', () => {
    expect(homeArrival()).toBeNull();
    arriveHome({ sessionId: 'ses_1' });
    // A Home that mounts twice (dev) still finds it.
    expect(homeArrival()).toEqual({ sessionId: 'ses_1' });
    expect(homeArrival()).toEqual({ sessionId: 'ses_1' });
    clearHomeArrival();
    expect(homeArrival()).toBeNull();
  });

  it("finds the started session's row in the rail, a real chat's included", () => {
    expect(railIdFor('ses_1', ['s-demo', 'chat:ses_1'])).toBe('chat:ses_1');
    expect(railIdFor('run_7', ['run_7'])).toBe('run_7');
    expect(railIdFor('ses_2', ['chat:ses_1'])).toBeNull();
  });
});
