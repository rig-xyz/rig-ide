import { describe, expect, it } from 'vitest';
import { deriveCreateFormState } from './create-form-state';

const base = { name: 'Knee Ability', parentDir: '/Users/dylan/Code', sync: true, signedIn: true, busy: false };

describe('deriveCreateFormState', () => {
  it('is submittable with a valid name, a chosen folder, and nothing in flight', () => {
    expect(deriveCreateFormState(base)).toEqual({
      slug: 'knee-ability',
      showSlugPreview: true,
      nameError: null,
      canSubmit: true,
      syncEffective: true,
      syncNeedsSignIn: false,
    });
  });

  it('hides the slug preview when the name is already its own slug', () => {
    const state = deriveCreateFormState({ ...base, name: 'knee-ability' });
    expect(state.slug).toBe('knee-ability');
    expect(state.showSlugPreview).toBe(false);
  });

  it('never scolds a pristine empty field, but blocks submit', () => {
    const state = deriveCreateFormState({ ...base, name: '' });
    expect(state.nameError).toBeNull();
    expect(state.canSubmit).toBe(false);
  });

  it('surfaces the validation message once something unusable was typed', () => {
    expect(deriveCreateFormState({ ...base, name: '!!!' }).nameError).toBe(
      'The name needs at least one letter or number.'
    );
  });

  it('blocks submit without a chosen folder or while creating', () => {
    expect(deriveCreateFormState({ ...base, parentDir: null }).canSubmit).toBe(false);
    expect(deriveCreateFormState({ ...base, busy: true }).canSubmit).toBe(false);
  });

  it('gates sync on sign-in: intent stays visible, effect waits', () => {
    const signedOut = deriveCreateFormState({ ...base, signedIn: false });
    expect(signedOut.syncEffective).toBe(false);
    expect(signedOut.syncNeedsSignIn).toBe(true);
    // Toggle off: no sign-in nag at all.
    const off = deriveCreateFormState({ ...base, sync: false, signedIn: false });
    expect(off.syncEffective).toBe(false);
    expect(off.syncNeedsSignIn).toBe(false);
  });
});
