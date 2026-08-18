/**
 * Pure derivation for the New-rig dialog: what the form can do right now,
 * from what's been entered. Kept out of the component so the rules — when
 * the slug preview shows, when submit is possible, when the sync toggle is
 * genuinely effective vs blocked on sign-in — are tested facts.
 */

import { rigSlug, validateRigName } from '@shared/rig/create';

export type CreateFormState = {
  slug: string;
  /** Show the mono preview only when slugging actually changes the name. */
  showSlugPreview: boolean;
  /** Validation message for the name — only once something was typed (no scolding an empty pristine field). */
  nameError: string | null;
  /** Everything present and valid, and nothing in flight. */
  canSubmit: boolean;
  /** What the create call should actually request — sync intent gated on being signed in. */
  syncEffective: boolean;
  /** The toggle is on but sign-in is missing: show the sign-in affordance + honest note. */
  syncNeedsSignIn: boolean;
};

export function deriveCreateFormState(input: {
  name: string;
  parentDir: string | null;
  sync: boolean;
  signedIn: boolean;
  busy: boolean;
}): CreateFormState {
  const { name, parentDir, sync, signedIn, busy } = input;
  const slug = rigSlug(name);
  const validation = validateRigName(name);
  return {
    slug,
    showSlugPreview: slug.length > 0 && slug !== name.trim(),
    nameError: name.length > 0 ? validation : null,
    canSubmit: validation === null && parentDir !== null && !busy,
    syncEffective: sync && signedIn,
    syncNeedsSignIn: sync && !signedIn,
  };
}
