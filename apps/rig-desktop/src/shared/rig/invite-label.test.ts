import { describe, expect, it } from 'vitest';
import { inviteRoleLabel, inviteTargetLabel, parseBindingKind, worksUntilLabel } from './invite-label';

describe('invite labels', () => {
  it('uses # only for a space', () => {
    expect(inviteTargetLabel('space', 'launch')).toBe('#launch');
    expect(inviteTargetLabel('rig', 'notes')).toBe('notes');
    expect(inviteTargetLabel(null, 'launch')).toBe('#launch');
  });

  it('names an unnamed one by its kind, never "Unnamed rig"', () => {
    expect(inviteTargetLabel('space', '  ')).toBe('a space');
    expect(inviteTargetLabel('rig', null)).toBe('a shared folder');
  });

  it('says roles the way the Room does', () => {
    expect(inviteRoleLabel('editor')).toBe('can edit');
    expect(inviteRoleLabel('viewer')).toBe('can view');
    expect(inviteRoleLabel(null)).toBe('can edit');
  });

  it('says when a link stops working, and nothing for one with no end', () => {
    expect(worksUntilLabel('2026-10-14T12:00:00Z')).toBe('Works until Oct 14');
    expect(worksUntilLabel(null)).toBeNull();
    expect(worksUntilLabel('soon')).toBeNull();
  });

  it('reads only the kinds it knows', () => {
    expect(parseBindingKind('space')).toBe('space');
    expect(parseBindingKind('rig')).toBe('rig');
    expect(parseBindingKind('folder')).toBeNull();
  });
});
