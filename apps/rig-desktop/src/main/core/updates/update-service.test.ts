import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron-updater', () => ({
  default: { autoUpdater: {} },
}));

vi.mock('@main/core/app/utils', () => ({
  resolveAppVersion: vi.fn(async () => '0.0.0'),
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: vi.fn() },
}));

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@main/rig/settings-instance', () => ({
  rigSettingsStore: { get: vi.fn(() => ({ updateLastCheckedAt: null })) },
}));

const { shouldCheckOnFocus } = await import('./update-service');

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

describe('shouldCheckOnFocus', () => {
  it('checks immediately when no check has ever resolved', () => {
    expect(shouldCheckOnFocus({ lastCheckedAt: null, now: 1_000, inFlight: false })).toBe(true);
  });

  it('never checks while a check is already in flight, even if the throttle window has long passed', () => {
    expect(shouldCheckOnFocus({ lastCheckedAt: null, now: 1_000, inFlight: true })).toBe(false);
    expect(
      shouldCheckOnFocus({ lastCheckedAt: 0, now: FIFTEEN_MIN_MS * 10, inFlight: true })
    ).toBe(false);
  });

  it('withholds the check before the 15-minute throttle window has elapsed', () => {
    const lastCheckedAt = 1_000_000;
    expect(
      shouldCheckOnFocus({ lastCheckedAt, now: lastCheckedAt + FIFTEEN_MIN_MS - 1, inFlight: false })
    ).toBe(false);
  });

  it('allows the check exactly at the 15-minute boundary and beyond', () => {
    const lastCheckedAt = 1_000_000;
    expect(
      shouldCheckOnFocus({ lastCheckedAt, now: lastCheckedAt + FIFTEEN_MIN_MS, inFlight: false })
    ).toBe(true);
    expect(
      shouldCheckOnFocus({ lastCheckedAt, now: lastCheckedAt + FIFTEEN_MIN_MS + 1, inFlight: false })
    ).toBe(true);
  });
});
