import { describe, expect, it } from 'vitest';
import { formatClockTime, formatSessionFromLabel, formatShortDate, relativeTime } from './session-history';

const NOW = Date.parse('2026-08-14T20:00:00.000Z');

describe('relativeTime', () => {
  it('says "now" for anything under a minute', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('now');
    expect(relativeTime(NOW, NOW)).toBe('now');
  });

  it('formats minutes', () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });

  it('formats hours', () => {
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
  });

  it('formats days', () => {
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });

  it('formats months for anything past 30 days', () => {
    expect(relativeTime(NOW - 60 * 86_400_000, NOW)).toBe('2mo ago');
  });

  it('never goes negative for a future timestamp (clock skew)', () => {
    expect(relativeTime(NOW + 10_000, NOW)).toBe('now');
  });
});

describe('formatClockTime', () => {
  it('formats as h:mm + lowercase am/pm with no space', () => {
    expect(formatClockTime(NOW)).toMatch(/^\d{1,2}:\d{2}(am|pm)$/);
  });

  it('returns empty string for an unparseable timestamp', () => {
    expect(formatClockTime(NaN)).toBe('');
  });
});

describe('formatShortDate', () => {
  it('formats as "Mon D"', () => {
    expect(formatShortDate(NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('returns empty string for an unparseable timestamp', () => {
    expect(formatShortDate(NaN)).toBe('');
  });
});

describe('formatSessionFromLabel', () => {
  it('combines date and time', () => {
    expect(formatSessionFromLabel(NOW)).toMatch(/^Session from [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}(am|pm)$/);
  });

  it('degrades to a plain label on a bad timestamp', () => {
    expect(formatSessionFromLabel(NaN)).toBe('Session');
  });
});
