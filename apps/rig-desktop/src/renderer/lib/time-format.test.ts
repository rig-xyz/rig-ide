import { describe, expect, it } from 'vitest';
import { dayKey, dayStart, formatClock, formatClockShort, formatDayLabel, formatFull, formatRelative } from './time-format';

const NOW = new Date(2026, 8, 24, 15, 0); // Thu Sep 24 2026, 15:00 local

describe('time-format', () => {
  it('returns empty strings for unparseable input', () => {
    expect(formatClock('nope')).toBe('');
    expect(formatDayLabel('nope', NOW)).toBe('');
    expect(formatRelative('nope', NOW)).toBe('');
    expect(formatFull('nope')).toBe('');
    expect(dayKey('nope')).toBe('');
  });

  it('labels days relative to now', () => {
    expect(formatDayLabel(new Date(2026, 8, 24, 0, 5), NOW)).toBe('Today');
    expect(formatDayLabel(new Date(2026, 8, 23, 23, 59), NOW)).toBe('Yesterday');
    expect(formatDayLabel(new Date(2026, 8, 21, 9), NOW)).toBe(
      new Date(2026, 8, 21).toLocaleDateString(undefined, { weekday: 'long' })
    );
    expect(formatDayLabel(new Date(2025, 0, 2), NOW)).toContain('2025');
  });

  it('groups by local calendar day', () => {
    expect(dayKey(new Date(2026, 8, 24, 0, 1))).toBe(dayKey(new Date(2026, 8, 24, 23, 59)));
    expect(dayKey(new Date(2026, 8, 24))).not.toBe(dayKey(new Date(2026, 8, 23)));
  });

  it('gives short relative ages', () => {
    expect(formatRelative(new Date(NOW.getTime() - 20_000), NOW)).toBe('now');
    expect(formatRelative(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe('5m');
    expect(formatRelative(new Date(NOW.getTime() - 3 * 3_600_000), NOW)).toBe('3h');
    expect(formatRelative(new Date(NOW.getTime() - 2 * 86_400_000), NOW)).toBe('2d');
  });

  it('drops AM/PM for the short clock', () => {
    const short = formatClockShort(new Date(2026, 8, 24, 22, 40));
    expect(short).toMatch(/^\d{1,2}[:.]40$/);
    expect(formatClockShort('nope')).toBe('');
  });

  it('orders days by their local midnight', () => {
    expect(dayStart(new Date(2026, 8, 24, 23))).toBeGreaterThan(dayStart(new Date(2026, 8, 23, 1)));
    expect(Number.isNaN(dayStart('nope'))).toBe(true);
  });
});
