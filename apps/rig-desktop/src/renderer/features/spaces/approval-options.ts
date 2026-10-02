/**
 * Which of a permission request's options is which, in one place: the
 * session card's `ApprovalCard` orders its buttons with it, and the For you
 * panel's Approve / Reject answer with it.
 */

import type { SessionPermissionOption } from './types';

/** Deny quietest (0), "Always" in between (1), the one-off allow is the primary (2). */
export function permissionOptionRank(kind: string): 0 | 1 | 2 {
  return kind.startsWith('reject') ? 0 : kind === 'allow_always' ? 1 : 2;
}

/** Deny first, the primary allow last: the order the card's buttons read in. */
export function sortPermissionOptions<T extends { kind: string }>(options: readonly T[]): T[] {
  return [...options].sort((a, b) => permissionOptionRank(a.kind) - permissionOptionRank(b.kind));
}

/** The option "Approve" answers with: the one-off allow, else any other non-reject, non-"always" option, else "Always allow". */
export function approveOption(
  options: readonly SessionPermissionOption[]
): SessionPermissionOption | undefined {
  return (
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => permissionOptionRank(o.kind) === 2) ??
    options.find((o) => o.kind === 'allow_always')
  );
}

/** The option "Reject" answers with: the one-off deny, else any deny. */
export function rejectOption(
  options: readonly SessionPermissionOption[]
): SessionPermissionOption | undefined {
  return (
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => permissionOptionRank(o.kind) === 0)
  );
}
