import { beforeEach, describe, expect, it } from 'vitest';
import { clearZeroStateDraft, getZeroStateDraft, setZeroStateDraft } from './rig-session-registry';

/**
 * The zero-state draft cache is the fix for "composer draft lost when
 * navigating away" (bug 2): a zero-state tab's eager `RigChatStore` is torn
 * down whenever the panel loses this rig or the tab stops being active, so
 * this module-level map — keyed by rig binding id, independent of any store
 * instance — is what actually survives that teardown.
 */
describe('zero-state draft cache', () => {
  const bindingId = 'rig-1';

  beforeEach(() => {
    clearZeroStateDraft(bindingId);
    clearZeroStateDraft('rig-2');
  });

  it('returns an empty string when nothing was ever stored', () => {
    expect(getZeroStateDraft(bindingId)).toBe('');
  });

  it('remembers the last text written for a binding id', () => {
    setZeroStateDraft(bindingId, 'hello');
    expect(getZeroStateDraft(bindingId)).toBe('hello');

    setZeroStateDraft(bindingId, 'hello there');
    expect(getZeroStateDraft(bindingId)).toBe('hello there');
  });

  it('keeps drafts for different rigs independent', () => {
    setZeroStateDraft(bindingId, 'for rig 1');
    setZeroStateDraft('rig-2', 'for rig 2');

    expect(getZeroStateDraft(bindingId)).toBe('for rig 1');
    expect(getZeroStateDraft('rig-2')).toBe('for rig 2');
  });

  it('clears the entry when written with an empty string', () => {
    setZeroStateDraft(bindingId, 'draft');
    setZeroStateDraft(bindingId, '');
    expect(getZeroStateDraft(bindingId)).toBe('');
  });

  it('clearZeroStateDraft removes a stored draft outright', () => {
    setZeroStateDraft(bindingId, 'draft');
    clearZeroStateDraft(bindingId);
    expect(getZeroStateDraft(bindingId)).toBe('');
  });

  it('clearing a binding id with nothing stored is a no-op', () => {
    expect(() => clearZeroStateDraft('never-written')).not.toThrow();
    expect(getZeroStateDraft('never-written')).toBe('');
  });
});
