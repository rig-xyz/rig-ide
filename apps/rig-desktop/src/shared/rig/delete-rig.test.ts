import { describe, expect, it } from 'vitest';
import {
  deriveDeleteRigButtonLabel,
  deriveDeleteRigCopy,
  deriveDeleteRigFailureMessage,
  deriveDeleteRigMode,
  deriveFolderKeptNote,
  deriveRigMenuLabel,
} from './delete-rig';

describe('deriveDeleteRigMode', () => {
  it('maps owner to delete, any other known role to leave, and unknown to local', () => {
    expect(deriveDeleteRigMode('owner')).toBe('delete');
    expect(deriveDeleteRigMode('editor')).toBe('leave');
    expect(deriveDeleteRigMode('viewer')).toBe('leave');
    expect(deriveDeleteRigMode('some-future-role')).toBe('leave');
    expect(deriveDeleteRigMode(null)).toBe('local');
  });
});

describe('deriveRigMenuLabel / deriveDeleteRigButtonLabel', () => {
  it('reads "Delete rig…" for delete and local, "Leave rig…" only for leave', () => {
    expect(deriveRigMenuLabel('delete')).toBe('Delete rig…');
    expect(deriveRigMenuLabel('local')).toBe('Delete rig…');
    expect(deriveRigMenuLabel('leave')).toBe('Leave rig…');
  });

  it('drops the ellipsis on the dialog\'s own submit button', () => {
    expect(deriveDeleteRigButtonLabel('delete')).toBe('Delete rig');
    expect(deriveDeleteRigButtonLabel('local')).toBe('Delete rig');
    expect(deriveDeleteRigButtonLabel('leave')).toBe('Leave rig');
  });

  it('says "space" for a space (lane J)', () => {
    expect(deriveRigMenuLabel('leave', 'space')).toBe('Leave space…');
    expect(deriveRigMenuLabel('delete', 'space')).toBe('Delete space…');
    expect(deriveDeleteRigButtonLabel('leave', 'space')).toBe('Leave space');
    expect(deriveDeleteRigCopy({ mode: 'delete', name: null, memberCount: 0, noun: 'space' })).toEqual({
      title: 'Delete this space?',
      body: 'Stops syncing on this computer. Removes the space for everyone. Nobody else has access.',
    });
  });
});

describe('deriveDeleteRigCopy', () => {
  it('local mode: no syncing/relay language, no member count', () => {
    expect(deriveDeleteRigCopy({ mode: 'local', name: 'Roadmap', memberCount: null })).toEqual({
      title: 'Delete Roadmap?',
      body: 'Removes it from your rigs on this computer.',
    });
  });

  it('falls back to "this rig" when the name is unknown', () => {
    expect(deriveDeleteRigCopy({ mode: 'local', name: null, memberCount: null })).toEqual({
      title: 'Delete this rig?',
      body: 'Removes it from your rigs on this computer.',
    });
  });

  it('owner delete: names how many people lose access', () => {
    expect(deriveDeleteRigCopy({ mode: 'delete', name: 'Roadmap', memberCount: 3 })).toEqual({
      title: 'Delete Roadmap?',
      body: 'Stops syncing on this computer. Removes the rig for everyone: 3 people will lose access.',
    });
  });

  it('owner delete: singular "person"', () => {
    const copy = deriveDeleteRigCopy({ mode: 'delete', name: 'Roadmap', memberCount: 1 });
    expect(copy.body).toBe(
      'Stops syncing on this computer. Removes the rig for everyone: 1 person will lose access.'
    );
  });

  it('owner delete: "Nobody else has access." at zero members', () => {
    expect(deriveDeleteRigCopy({ mode: 'delete', name: 'Roadmap', memberCount: 0 })).toEqual({
      title: 'Delete Roadmap?',
      body: 'Stops syncing on this computer. Removes the rig for everyone. Nobody else has access.',
    });
    // Never-resolved count is treated the same as a confirmed zero.
    expect(deriveDeleteRigCopy({ mode: 'delete', name: 'Roadmap', memberCount: null }).body).toBe(
      'Stops syncing on this computer. Removes the rig for everyone. Nobody else has access.'
    );
  });

  it('leave: names the owner and the other members, excluding self and the owner', () => {
    // memberCount excludes the caller; 3 others means 1 owner + 2 more.
    expect(deriveDeleteRigCopy({ mode: 'leave', name: 'Roadmap', memberCount: 3 })).toEqual({
      title: 'Leave Roadmap?',
      body: "Stops syncing on this computer. You'll lose access; the rig stays for its owner and the other 2 people.",
    });
  });

  it('leave: just the owner when there is no one else', () => {
    expect(deriveDeleteRigCopy({ mode: 'leave', name: 'Roadmap', memberCount: 1 })).toEqual({
      title: 'Leave Roadmap?',
      body: "Stops syncing on this computer. You'll lose access; the rig stays for its owner.",
    });
    expect(deriveDeleteRigCopy({ mode: 'leave', name: 'Roadmap', memberCount: null }).body).toBe(
      "Stops syncing on this computer. You'll lose access; the rig stays for its owner."
    );
  });
});

describe('deriveFolderKeptNote', () => {
  it('names the path verbatim', () => {
    expect(deriveFolderKeptNote('/Users/dylan/Rig/roadmap')).toBe(
      'Your files stay in /Users/dylan/Rig/roadmap.'
    );
  });
});

describe('deriveDeleteRigFailureMessage', () => {
  it('the two relay-specific codes point at the other action', () => {
    expect(deriveDeleteRigFailureMessage('forbiddenOwnerOnly', 'delete')).toBe(
      'Only the owner can delete this rig. You can leave it instead.'
    );
    expect(deriveDeleteRigFailureMessage('ownerCannotLeave', 'leave')).toBe(
      "The owner can't leave; delete the rig instead."
    );
  });

  it('a generic failure is worded for whichever action was attempted', () => {
    expect(deriveDeleteRigFailureMessage('network', 'delete')).toBe("Couldn't delete this rig. Try again.");
    expect(deriveDeleteRigFailureMessage('other', 'leave')).toBe("Couldn't leave this rig. Try again.");
  });
});
