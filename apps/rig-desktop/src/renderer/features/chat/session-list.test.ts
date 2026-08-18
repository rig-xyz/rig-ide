import { describe, expect, it } from 'vitest';
import { addSession, byRecency, closeTab, deriveTabTitle, removeSession } from './session-list';

function session(id: string, createdAt: number) {
  return { conversationId: id, providerId: 'claude', createdAt, kind: 'live' as const };
}

describe('session-list', () => {
  it('addSession appends without mutating the input array', () => {
    const initial = [session('a', 1)];
    const next = addSession(initial, session('b', 2));

    expect(initial).toHaveLength(1);
    expect(next.map((s) => s.conversationId)).toEqual(['a', 'b']);
  });

  it('removeSession drops only the matching id', () => {
    const sessions = [session('a', 1), session('b', 2)];
    expect(removeSession(sessions, 'a').map((s) => s.conversationId)).toEqual(['b']);
    expect(removeSession(sessions, 'missing')).toHaveLength(2);
  });

  it('byRecency sorts newest first without mutating the input', () => {
    const sessions = [session('a', 1), session('b', 3), session('c', 2)];
    const sorted = byRecency(sessions);
    expect(sorted.map((s) => s.conversationId)).toEqual(['b', 'c', 'a']);
    expect(sessions.map((s) => s.conversationId)).toEqual(['a', 'b', 'c']);
  });

  describe('closeTab', () => {
    it('closing a background tab leaves the active tab untouched', () => {
      const sessions = [session('a', 1), session('b', 2)];
      const result = closeTab(sessions, 'a', 'b');
      expect(result.sessions.map((s) => s.conversationId)).toEqual(['a']);
      expect(result.activeId).toBe('a');
    });

    it('closing the active tab hands off to the next-most-recent survivor', () => {
      const sessions = [session('a', 1), session('b', 2), session('c', 3)];
      const result = closeTab(sessions, 'c', 'c');
      expect(result.sessions.map((s) => s.conversationId).sort()).toEqual(['a', 'b']);
      // Newest of the survivors (byRecency: b created after a).
      expect(result.activeId).toBe('b');
    });

    it('closing the last tab returns to the zero-state', () => {
      const sessions = [session('a', 1)];
      const result = closeTab(sessions, 'a', 'a');
      expect(result.sessions).toEqual([]);
      expect(result.activeId).toBeNull();
    });

    it('closing an id that is not the active one, with no active tab, stays null', () => {
      const sessions = [session('a', 1), session('b', 2)];
      const result = closeTab(sessions, null, 'a');
      expect(result.activeId).toBeNull();
      expect(result.sessions.map((s) => s.conversationId)).toEqual(['b']);
    });
  });

  describe('deriveTabTitle', () => {
    it('uses the session title once it has one', () => {
      expect(deriveTabTitle('Fix the flaky test')).toBe('Fix the flaky test');
    });

    it('falls back to a plain placeholder before the first prompt', () => {
      expect(deriveTabTitle(null)).toBe('New session');
    });
  });
});
