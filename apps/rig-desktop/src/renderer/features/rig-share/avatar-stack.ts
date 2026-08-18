/**
 * Pure derivation for the Share trigger's stacked member avatars: at most
 * `cap` faces, then a single "+N" chip for the rest — never "+1 face worth
 * of overflow chip" arithmetic scattered in JSX. Order is preserved exactly
 * as given (the relay's member order), so the stack is stable across polls.
 */

export type AvatarStackPerson = {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
};

export type AvatarStack<T extends AvatarStackPerson> = {
  visible: T[];
  /** People beyond the cap — 0 means no "+N" chip at all. */
  overflow: number;
};

export const AVATAR_STACK_CAP = 3;

export function deriveAvatarStack<T extends AvatarStackPerson>(
  people: T[],
  cap: number = AVATAR_STACK_CAP
): AvatarStack<T> {
  if (cap <= 0) return { visible: [], overflow: people.length };
  if (people.length <= cap) return { visible: people, overflow: 0 };
  return { visible: people.slice(0, cap), overflow: people.length - cap };
}
