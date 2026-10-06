import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./file-logger', () => ({ getLogFileDestination: () => ({ write: () => true }) }));

const { defaultLogLevel } = await import('./logger');

describe('defaultLogLevel', () => {
  it('a packaged build logs Rig at info', () => {
    expect(defaultLogLevel({}, { packaged: true, debugFlag: false })).toBe('info');
  });

  it('dev builds keep the shared default', () => {
    expect(defaultLogLevel({}, { packaged: false, debugFlag: false })).toBeUndefined();
  });

  it('the env and --debug-logs still win', () => {
    expect(defaultLogLevel({ EMDASH_LOG_LEVEL: 'warn' }, { packaged: true, debugFlag: true })).toBe(
      'warn'
    );
    expect(defaultLogLevel({ LOG_LEVEL: 'error' }, { packaged: true, debugFlag: false })).toBe(
      'error'
    );
    expect(defaultLogLevel({}, { packaged: true, debugFlag: true })).toBe('debug');
  });
});
