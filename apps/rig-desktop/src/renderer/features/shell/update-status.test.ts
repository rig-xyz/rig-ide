import { describe, expect, it } from 'vitest';
import {
  deriveUpdateAction,
  deriveUpdateStatusLine,
  INITIAL_UPDATE_VIEW_STATE,
  isUpdateReady,
  mapInitialStatus,
  reduceUpdateState,
  shouldAnnounceUpdate,
  type UpdateEvent,
  type UpdateViewState,
} from './update-status';

const NOW = Date.parse('2026-08-18T12:00:00Z');

/** Folds a sequence of events through `reduceUpdateState`, threading the same `now` — the "event sequence → displayed state" shape the round asked for. */
function play(events: readonly UpdateEvent[], start: UpdateViewState = INITIAL_UPDATE_VIEW_STATE): UpdateViewState {
  return events.reduce((state, event) => reduceUpdateState(state, event, NOW), start);
}

describe('reduceUpdateState — event sequences', () => {
  it('checking clears a stale error but otherwise just flips status', () => {
    const afterError = play([{ kind: 'error', message: 'offline' }]);
    const result = play([{ kind: 'checking' }], afterError);
    expect(result.status).toBe('checking');
    expect(result.errorMessage).toBeNull();
  });

  it('available stays "checking" visually but records the version and a resolution timestamp', () => {
    const result = play([{ kind: 'checking' }, { kind: 'available', version: '2.0.0' }]);
    expect(result.status).toBe('checking');
    expect(result.availableVersion).toBe('2.0.0');
    expect(result.lastCheckedAt).toBe(NOW);
  });

  it('notAvailable resolves to idle, clears any stale availableVersion, and records the check time', () => {
    const result = play([
      { kind: 'checking' },
      { kind: 'available', version: '2.0.0' },
      { kind: 'checking' },
      { kind: 'notAvailable' },
    ]);
    expect(result).toEqual({
      status: 'idle',
      currentVersion: '',
      availableVersion: null,
      percent: null,
      errorMessage: null,
      lastCheckedAt: NOW,
    });
  });

  it('the full happy path: checking → available → downloading → progress ticks → downloaded', () => {
    const result = play([
      { kind: 'checking' },
      { kind: 'available', version: '2.0.0' },
      { kind: 'downloading', version: '2.0.0' },
      { kind: 'progress', percent: 10 },
      { kind: 'progress', percent: 63.4 },
      { kind: 'downloaded', version: '2.0.0' },
    ]);
    expect(result.status).toBe('ready');
    expect(result.availableVersion).toBe('2.0.0');
    expect(result.percent).toBe(100);
  });

  it('downloading resets percent to null (a fresh download never inherits a previous one\'s progress)', () => {
    const midway = play([
      { kind: 'downloading', version: '1.0.0' },
      { kind: 'progress', percent: 80 },
    ]);
    const result = reduceUpdateState(midway, { kind: 'downloading', version: '2.0.0' }, NOW);
    expect(result.percent).toBeNull();
    expect(result.availableVersion).toBe('2.0.0');
  });

  it('error mid-download preserves the availableVersion and last progress — never silently reverts to "up to date"', () => {
    const result = play([
      { kind: 'downloading', version: '2.0.0' },
      { kind: 'progress', percent: 40 },
      { kind: 'error', message: 'network blip' },
    ]);
    expect(result.status).toBe('error');
    expect(result.availableVersion).toBe('2.0.0');
    expect(result.percent).toBe(40);
    expect(result.errorMessage).toBe('network blip');
  });

  it('error never advances lastCheckedAt — a failed attempt is not a resolution', () => {
    const before = play([{ kind: 'checking' }, { kind: 'notAvailable' }]); // lastCheckedAt = NOW
    const later = NOW + 60_000;
    const result = reduceUpdateState(before, { kind: 'error', message: 'boom' }, later);
    expect(result.lastCheckedAt).toBe(NOW);
  });

  it('a retry after an error can still resolve normally', () => {
    const result = play([
      { kind: 'checking' },
      { kind: 'error', message: 'offline' },
      { kind: 'checking' },
      { kind: 'notAvailable' },
    ]);
    expect(result.status).toBe('idle');
    expect(result.errorMessage).toBeNull();
  });
});

describe('mapInitialStatus', () => {
  it('folds main\'s "available" onto "checking" — no distinct UI for the pre-auto-download instant', () => {
    expect(mapInitialStatus('available')).toBe('checking');
  });

  it('folds "installing" onto "ready" — the button was already clicked, the app is about to quit', () => {
    expect(mapInitialStatus('installing')).toBe('ready');
  });

  it('"downloaded" maps to "ready"', () => {
    expect(mapInitialStatus('downloaded')).toBe('ready');
  });

  it('everything else maps 1:1, with an unknown value degrading to idle rather than throwing', () => {
    expect(mapInitialStatus('checking')).toBe('checking');
    expect(mapInitialStatus('downloading')).toBe('downloading');
    expect(mapInitialStatus('error')).toBe('error');
    expect(mapInitialStatus('idle')).toBe('idle');
    expect(mapInitialStatus('something-new')).toBe('idle');
  });
});

describe('deriveUpdateStatusLine', () => {
  it('checking', () => {
    expect(deriveUpdateStatusLine({ ...INITIAL_UPDATE_VIEW_STATE, status: 'checking' }, NOW)).toBe('Checking…');
  });

  it('downloading with a real percent — never fabricated, always rounded', () => {
    expect(
      deriveUpdateStatusLine(
        { ...INITIAL_UPDATE_VIEW_STATE, status: 'downloading', availableVersion: '2.0.0', percent: 41.6 },
        NOW
      )
    ).toBe('Rig 2.0.0 · downloading 42%');
  });

  it('downloading with no percent yet — says so honestly, no invented number', () => {
    expect(
      deriveUpdateStatusLine(
        { ...INITIAL_UPDATE_VIEW_STATE, status: 'downloading', availableVersion: '2.0.0', percent: null },
        NOW
      )
    ).toBe('Rig 2.0.0 · downloading');
  });

  it('ready names the version', () => {
    expect(
      deriveUpdateStatusLine({ ...INITIAL_UPDATE_VIEW_STATE, status: 'ready', availableVersion: '2.0.0' }, NOW)
    ).toBe('Rig 2.0.0 ready');
  });

  it('error is a plain honest line, never "up to date"', () => {
    expect(
      deriveUpdateStatusLine({ ...INITIAL_UPDATE_VIEW_STATE, status: 'error', errorMessage: 'offline' }, NOW)
    ).toBe("Couldn't check for updates");
  });

  it('idle with a known last-check time', () => {
    const checkedAt = NOW - 2 * 60 * 60 * 1000;
    expect(deriveUpdateStatusLine({ ...INITIAL_UPDATE_VIEW_STATE, status: 'idle', lastCheckedAt: checkedAt }, NOW)).toBe(
      'Up to date · checked 2h ago'
    );
  });

  it('idle with no known last-check time (never checked this install) — no fabricated time', () => {
    expect(deriveUpdateStatusLine({ ...INITIAL_UPDATE_VIEW_STATE, status: 'idle', lastCheckedAt: null }, NOW)).toBe(
      'Up to date'
    );
  });
});

describe('deriveUpdateAction', () => {
  it('idle/error offer a retry, enabled', () => {
    expect(deriveUpdateAction('idle')).toEqual({ kind: 'check', label: 'Check for updates', disabled: false });
    expect(deriveUpdateAction('error')).toEqual({ kind: 'check', label: 'Check for updates', disabled: false });
  });

  it('checking/downloading disable the button — nothing to do mid-flight', () => {
    expect(deriveUpdateAction('checking')).toEqual({ kind: 'check', label: 'Check for updates', disabled: true });
    expect(deriveUpdateAction('downloading')).toEqual({
      kind: 'check',
      label: 'Check for updates',
      disabled: true,
    });
  });

  it('ready swaps to Restart', () => {
    expect(deriveUpdateAction('ready')).toEqual({ kind: 'restart', label: 'Restart to update' });
  });
});

describe('isUpdateReady (the topbar dot)', () => {
  it('true only for ready, false for every other status — never for an update that is not actually downloaded', () => {
    const statuses = ['idle', 'checking', 'downloading', 'error'] as const;
    for (const status of statuses) {
      expect(isUpdateReady({ ...INITIAL_UPDATE_VIEW_STATE, status })).toBe(false);
    }
    expect(isUpdateReady({ ...INITIAL_UPDATE_VIEW_STATE, status: 'ready', availableVersion: '2.0.0' })).toBe(true);
  });
});

describe('shouldAnnounceUpdate', () => {
  const ready = (version: string): UpdateViewState => ({
    ...INITIAL_UPDATE_VIEW_STATE,
    status: 'ready',
    availableVersion: version,
  });

  it('a freshly-ready update with nothing announced yet — announce', () => {
    expect(shouldAnnounceUpdate(ready('2.0.0'), null)).toBe(true);
  });

  it('the SAME version already announced — do not re-nag', () => {
    expect(shouldAnnounceUpdate(ready('2.0.0'), '2.0.0')).toBe(false);
  });

  it('a NEWER version than what was announced — announce again', () => {
    expect(shouldAnnounceUpdate(ready('2.1.0'), '2.0.0')).toBe(true);
  });

  it('not ready yet — never announce regardless of what was previously announced', () => {
    expect(shouldAnnounceUpdate({ ...INITIAL_UPDATE_VIEW_STATE, status: 'downloading' }, null)).toBe(false);
  });
});
