/**
 * The state→layout decision for the home screen. Pure and side-effect free
 * on purpose: every input here is something a hook/query already produces
 * (auth status, local `rig_rigs` recents, `listRecentAcrossRigs`,
 * `rpc.rig.account.workspaces`) — this is only the "given what we know,
 * what do we show" logic, kept separate from the fetching so it's testable
 * without mocking RPC at all.
 *
 * Round: HOME RESTRUCTURE — CONTINUE and RIGS (two separate sections) are
 * gone; there is now ONE rig-centric list (`buildHomeRigRows`), each rig
 * carrying its own recent sessions as sub-rows. `deriveHomeRegions`
 * answers only "is there anything to show at all" (the true empty state)
 * and the health line — the pulse-driven center/right regions keep their
 * OWN gate, `pulse-state.ts`'s `shouldShowPulseSection`, untouched (kept
 * as a separate, already-tested function per the brief — "region
 * visibility" here is scoped to the rigs rail and the empty state, not a
 * reimplementation of pulse's own gate).
 */

import { formatShortDate } from '@renderer/features/chat/session-history';
import type { RigsRailFilter, RigsRailSort } from '@shared/rig/settings';

/** One `rig_rigs` row, as read from `rpc.rig.recent.recentRigs`. */
export type HomeLocalRig = {
  bindingId: string;
  name: string | null;
  path: string;
  lastOpenedAt: number;
};

/** One cross-rig recent session, as read from `rpc.rig.sessions.listRecentAcrossRigs`. */
export type HomeRecentSession = {
  id: string;
  providerId: string;
  title: string | null;
  updatedAt: number;
  rigBindingId: string;
  rigName: string | null;
  rigPath: string;
};

/** One relay workspace binding, as read from `rpc.rig.account.workspaces`. */
export type HomeBinding = {
  bindingId: string;
  name: string;
  lastSyncedAt: string | null;
  role: string;
  /** When the binding was created — the one human-meaningful tie-breaker for two visible rows sharing a name (see `disambiguateByName`). */
  createdAt: string;
};

/**
 * `rpc.rig.account.workspaces()`'s outcome, pre-digested: `'skipped'` when
 * we never called it (signed out — there's nothing to ask for), `'loading'`
 * while the call is in flight (never treated as "no data," so a slow relay
 * doesn't flash the minimal empty state before flipping to the richer one),
 * `'unreachable'` when it failed, `'ok'` with the real list otherwise.
 */
export type HomeWorkspacesState =
  | { status: 'skipped' }
  | { status: 'loading' }
  | { status: 'unreachable' }
  | { status: 'ok'; bindings: readonly HomeBinding[] };

export type HomeHealthMessage =
  | { kind: 'noAgent'; text: string }
  | { kind: 'signedOut'; text: string }
  | { kind: 'relayUnreachable'; text: string };

export type HomeRegions = {
  /** True = the true empty state (no rigs anywhere) — the hero is the ONLY thing that renders. */
  showEmptyState: boolean;
  /** The left rigs rail — works standalone even signed-out/solo (pulse's center/right regions have their own gate, `shouldShowPulseSection`). */
  showRigs: boolean;
  health: HomeHealthMessage | null;
};

export type HomeRegionsInput = {
  signedIn: boolean;
  hasRunnableAgent: boolean;
  localRigs: readonly HomeLocalRig[];
  recentSessions: readonly HomeRecentSession[];
  workspaces: HomeWorkspacesState;
};

/**
 * `deriveHomeRegions` is deliberately conservative about what counts as
 * "there's nothing to show yet": a workspaces call still in flight never
 * counts as *empty*, only as not-yet-known — so a signed-in user whose only
 * data lives on the relay (the invited-cofounder case: nothing opened
 * locally, but a rig was shared with them) doesn't get shown the bare empty
 * screen for the split second before that call resolves.
 */
export function deriveHomeRegions(input: HomeRegionsInput): HomeRegions {
  const bindingCount = input.workspaces.status === 'ok' ? input.workspaces.bindings.length : 0;
  const workspacesPending = input.workspaces.status === 'loading';
  const hasAnyRig =
    input.localRigs.length > 0 ||
    input.recentSessions.length > 0 ||
    bindingCount > 0 ||
    workspacesPending;

  const showEmptyState = !hasAnyRig;
  const showRigs = !showEmptyState;

  // No health line at all in the empty state — that's the hero, untouched.
  let health: HomeHealthMessage | null = null;
  if (!showEmptyState) {
    if (!input.hasRunnableAgent) {
      health = {
        kind: 'noAgent',
        text: 'No runnable agent installed — install one to start or continue a session.',
      };
    } else if (!input.signedIn) {
      health = { kind: 'signedOut', text: "Sign in to see your team's rigs" };
    } else if (input.workspaces.status === 'unreachable') {
      health = { kind: 'relayUnreachable', text: 'offline · team rigs unavailable right now' };
    }
  }

  return { showEmptyState, showRigs, health };
}

/** The bit of `rpc.rig.account.workspaces()`'s `Result` shape this module actually reads. */
export type WorkspacesQueryResult =
  | {
      success: true;
      data: readonly { id: string; name: string; lastSyncedAt: string | null; role: string; createdAt: string }[];
    }
  | { success: false; error: { kind: string } };

/**
 * Turns the raw `rpc.rig.account.workspaces()` query into a `HomeWorkspacesState`
 * — kept separate from `deriveHomeRegions` so the "which failure kind counts
 * as offline vs. effectively signed-out" call is its own tested unit rather
 * than buried inside a component. `notSignedIn` (the token expired between
 * the auth-status read and this call, or was revoked) degrades to `'skipped'`
 * — same as never having called it — since "sign in" is the correct action
 * either way; every other failure (a real `relay` error, or `untrustedRelay`)
 * is the honest "can't reach/trust the relay right now" mode.
 */
export function deriveWorkspacesState(
  signedIn: boolean,
  query: { isLoading: boolean; data: WorkspacesQueryResult | undefined }
): HomeWorkspacesState {
  if (!signedIn) return { status: 'skipped' };
  if (query.isLoading || !query.data) return { status: 'loading' };
  if (!query.data.success) {
    return query.data.error.kind === 'notSignedIn' ? { status: 'skipped' } : { status: 'unreachable' };
  }
  return {
    status: 'ok',
    bindings: query.data.data.map((b) => ({
      bindingId: b.id,
      name: b.name,
      lastSyncedAt: b.lastSyncedAt,
      role: b.role,
      createdAt: b.createdAt,
    })),
  };
}

/** One rig's session, as a sub-row under its rig (round: HOME RESTRUCTURE — CONTINUE folds into each rig row instead of its own flat section). */
export type HomeRigSession = {
  id: string;
  providerId: string;
  title: string | null;
  updatedAt: number;
};

export type HomeRigRow =
  | {
      kind: 'local';
      bindingId: string;
      name: string | null;
      path: string;
      lastOpenedAt: number;
      sessions: readonly HomeRigSession[];
    }
  | {
      kind: 'relayOnly';
      bindingId: string;
      name: string;
      /**
       * "created May 12" style, mono subtext — populated ONLY when this row's
       * `name` collides with another visible row's (see `disambiguateByName`).
       * Never folded into `name` itself: a hex bindingId suffix used to be
       * appended there and nobody could read anything into it.
       */
      disambiguator: string | null;
      /** See `canAutoJoin` — whether "Download" can be offered at all when there's no local copy. */
      canAutoJoin: boolean;
      /** The binding role this row was fetched with — see `deriveRelayOnlyRowStatus`, the one thing that decides whether "shared with you" is an honest thing to say about it. */
      role: string;
      /**
       * A real, already-synced local directory for this binding, found by
       * `rpc.rig.recent.resolveLocalPaths` (`rig_rigs`, existence-verified —
       * no filesystem scan) — null when genuinely not known to be anywhere
       * on this machine. A null value is never shown as a path; it only
       * means "Download"/"Locate…" are offered instead of "Open".
       */
      localPath: string | null;
      /**
       * D7 fix — true while `rpc.rig.recent.resolveLocalPaths` is still in
       * flight for this binding: `localPath === null` used to mean BOTH
       * "confirmed nowhere local" AND "haven't checked yet," conflated into
       * one state — which offered Download/Locate a beat too early, before
       * the app had actually confirmed there was nothing to just re-open.
       * A row with `localPathPending: true` shows a quiet "checking…"
       * instead of either "shared with you" or the Download/Locate actions.
       */
      localPathPending: boolean;
      /** Always empty — a relay-only row has no `rig_sessions` presence by definition (that table is scoped to rigs opened through this app). */
      sessions: readonly [];
    };

/**
 * Whether "Download" (drive `rig attach`) is offered at all for this
 * binding when there's no local copy. Round H2 gated this on `role ===
 * 'owner'` — the CLI's only automatable path back then was self-minting an
 * invite off an owner-only relay endpoint (`shared/rig/join.ts`'s header
 * comment has the history). Superseded: `rig attach` mints its device off
 * `POST /v1/me/bindings/:bindingId/devices`, which is member-gated, not
 * owner-gated, so any explicit member gets the same door. This still
 * whitelists the known roles rather than returning `true` unconditionally —
 * an unrecognized role string is treated honestly as "don't know," not
 * assumed to be a real member. "Locate…" has no such gate at all — reading
 * and verifying a folder the user already picked needs no relay permission,
 * so every role gets it regardless.
 */
const MEMBER_ROLES = new Set(['owner', 'editor', 'viewer']);
export function canAutoJoin(role: string): boolean {
  return MEMBER_ROLES.has(role);
}

/** The honest sentence behind the relay-only row's status icon — `rigs-rail.tsx`'s tooltip, verbatim. */
export const NOT_SET_UP_TOOLTIP = 'Not set up on this Mac — use ⋯ to download or locate';

/**
 * The relay-only row's status derivation (`rigs-rail.tsx`'s `RelayOnlyRigRow`)
 * — replaces the old text-only `relayOnlyStatusText`. Icon round (Dylan):
 * the repeated "not set up on this Mac" SENTENCE is redundant at scale once
 * every not-yet-local row says it — that fact now lives in a small status
 * icon + tooltip instead (`NOT_SET_UP_TOOLTIP` above), so this only decides
 * the one thing text still earns its keep for: whether "shared with you" is
 * an honest thing to say about the row at all.
 *
 * Bug fix carried over unchanged: this used to render "shared with you"
 * unconditionally — on a fresh install (empty `rig_rigs`), a rig the viewer
 * OWNS is relay-only too (never opened through this app yet), and calling
 * it "shared with you" is simply false. Only `'owner'` gets `null` (no
 * subtext at all — name + icon is the whole story); every other role —
 * including one this app doesn't recognize — keeps the sharing claim, same
 * "unknown is treated as not-a-known-member" caution `canAutoJoin` above
 * already uses.
 *
 * `'checking'`/`'localPath'` are the other two honest states a relay-only
 * row can be in (D7's pending fix, and a row whose local copy IS already
 * known) — folded into this one derivation so the component is a pure
 * switch on its result, not a re-derived ternary chain.
 */
export type RelayOnlyRowStatus =
  | { kind: 'checking' }
  | { kind: 'localPath'; path: string }
  | { kind: 'notSetUp'; sharedSubtext: string | null };

export function deriveRelayOnlyRowStatus(row: {
  localPathPending: boolean;
  localPath: string | null;
  role: string;
}): RelayOnlyRowStatus {
  if (row.localPathPending) return { kind: 'checking' };
  if (row.localPath !== null) return { kind: 'localPath', path: row.localPath };
  return { kind: 'notSetUp', sharedSubtext: row.role === 'owner' ? null : 'shared with you' };
}

/**
 * Attaches a human-meaningful, mono SUBTEXT to any row whose `name` collides
 * with another visible row's — two distinct bindings CAN legitimately share
 * a name. Correction round: the previous version appended the bindingId's
 * own last 6 characters into the displayed title (`"dup · 111111"`) — a
 * hex slug that meant nothing to Dylan. `GET /v1/me/bindings` does carry a
 * genuinely human-meaningful field per binding — `createdAt` — so the
 * disambiguator is now "created May 12" (mono), rendered as its own line,
 * never folded into the name. `null` when a `createdAt` is missing/malformed
 * (an older relay, or a degraded value) — no invented date is ever shown.
 */
export function disambiguateByName<T extends { bindingId: string; name: string; createdAt: string }>(
  rows: readonly T[]
): (T & { disambiguator: string | null })[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  return rows.map((row) => {
    if ((counts.get(row.name) ?? 0) <= 1) return { ...row, disambiguator: null };
    const at = Date.parse(row.createdAt);
    return { ...row, disambiguator: Number.isNaN(at) ? null : `created ${formatShortDate(at)}` };
  });
}

/** At most this many sessions render as sub-rows under one rig — a quiet list, not a second scroll region nested inside the first. */
const SESSIONS_PER_RIG_CAP = 3;

/**
 * Buckets `recentSessions` by their owning rig, newest-updated first within
 * each bucket, capped to `SESSIONS_PER_RIG_CAP` per rig — the pure half of
 * "each rig row carries its recent sessions inline as sub-rows." Exported
 * on its own (not just inlined into `buildHomeRigRows`) because grouping is
 * the one genuinely non-trivial step here and deserves its own tests,
 * independent of the merge/ordering logic around it.
 */
export function groupSessionsByRig(
  sessions: readonly HomeRecentSession[]
): Map<string, HomeRigSession[]> {
  const byRig = new Map<string, HomeRigSession[]>();
  for (const s of sessions) {
    const list = byRig.get(s.rigBindingId) ?? [];
    list.push({ id: s.id, providerId: s.providerId, title: s.title, updatedAt: s.updatedAt });
    byRig.set(s.rigBindingId, list);
  }
  for (const [bindingId, list] of byRig) {
    byRig.set(
      bindingId,
      [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SESSIONS_PER_RIG_CAP)
    );
  }
  return byRig;
}

/**
 * A local row's recency — the more recent of "last opened" and its freshest
 * attached session — a rig chatted in five minutes ago outranks one merely
 * opened (Finder, a terminal) a moment before that. Round 2 (Dylan — drop
 * the path, show last-activity): exported now, doubling as BOTH the sort
 * key `buildHomeRigRows` already used it for AND the honest last-activity
 * time `rigs-rail.tsx` displays, so the two can never silently disagree.
 *
 * Investigation for relay-only rows (no equivalent here): the relay's own
 * `rig_bindings.updated_at` — the only per-binding timestamp
 * `RigWorkspaceBinding` could plausibly carry — is written ONLY by
 * `updateBindingOrgVisibility`/`detachBindingFromOrg` (`tap`'s
 * `packages/relay/src/repos/bindings.ts`, confirmed against source): org
 * moves and visibility flips, never anything resembling rig activity. Using
 * it as "last activity" would be actively misleading (it would mostly just
 * equal `createdAt`, or jump for a reason unrelated to the rig's own
 * content). A relay-only row's last activity is instead treated as
 * genuinely unknown — no exported equivalent of this function for it,
 * `rigs-rail.tsx` renders nothing there rather than a fabricated number.
 */
export function localRecencyKey(row: { lastOpenedAt: number; sessions: readonly HomeRigSession[] }): number {
  return row.sessions.reduce((max, s) => Math.max(max, s.updatedAt), row.lastOpenedAt);
}

/**
 * Builds Home's ONE rig list (round: HOME RESTRUCTURE — replaces the old
 * `mergeRigsRows`, which fed a separate RIGS section, plus the separate
 * flat CONTINUE section this now absorbs as sub-rows). Matched by
 * `bindingId`, the one identity that survives a rig moving on disk (see
 * `rig_rigs`'s own doc comment). A binding with a local match is
 * represented once, as its local row, carrying up to
 * `SESSIONS_PER_RIG_CAP` of its own recent sessions; a binding with NO
 * `rig_rigs` match is the "shared with you" case — its own `relayOnly`
 * row, with `localPath` (from the caller's `resolveLocalPaths` lookup)
 * deciding whether it's actually already synced too (just never opened
 * through this app) or genuinely nowhere local yet — never any sessions,
 * by construction. Bindings are deduped by `bindingId` first (defensive —
 * a transient relay hiccup returning the same row twice must never produce
 * two rows for one binding); a genuine same-name collision between two
 * DIFFERENT bindingIds is disambiguated, not merged. Local rows sort by
 * `localRecencyKey` descending (most-recent-first, the list's own
 * headline promise); relay-only rows have no local recency signal to sort
 * by honestly, so they trail behind, alphabetically.
 */
export function buildHomeRigRows(
  localRigs: readonly HomeLocalRig[],
  workspaces: HomeWorkspacesState,
  recentSessions: readonly HomeRecentSession[],
  localPaths: ReadonlyMap<string, string> = new Map(),
  /** D7: true while `resolveLocalPaths` is still resolving for the relay-only bindings below — applied uniformly, since one query answers for all of them at once. */
  localPathsPending = false
): HomeRigRow[] {
  const sessionsByRig = groupSessionsByRig(recentSessions);
  const localByBinding = new Set(localRigs.map((r) => r.bindingId));

  const localRows: HomeRigRow[] = localRigs
    .map((r) => ({
      kind: 'local' as const,
      bindingId: r.bindingId,
      name: r.name,
      path: r.path,
      lastOpenedAt: r.lastOpenedAt,
      sessions: sessionsByRig.get(r.bindingId) ?? [],
    }))
    .sort((a, b) => localRecencyKey(b) - localRecencyKey(a));

  const bindings = workspaces.status === 'ok' ? workspaces.bindings : [];
  const dedupedBindings = [...new Map(bindings.map((b) => [b.bindingId, b])).values()];
  const relayOnly = dedupedBindings
    .filter((b) => !localByBinding.has(b.bindingId))
    .sort((a, b) => a.name.localeCompare(b.name));
  const relayOnlyRows: HomeRigRow[] = disambiguateByName(relayOnly).map((b) => ({
    kind: 'relayOnly',
    bindingId: b.bindingId,
    name: b.name,
    disambiguator: b.disambiguator,
    canAutoJoin: canAutoJoin(b.role),
    role: b.role,
    localPath: localPaths.get(b.bindingId) ?? null,
    localPathPending: localPathsPending,
    sessions: [],
  }));

  return [...localRows, ...relayOnlyRows];
}

/**
 * The pulse briefing round: what a rig-name chip in WHAT'S NEW/ACROSS YOUR
 * RIGS (`briefing-spine.tsx`) does when clicked — a LINK now, not inert
 * mono text. A local match opens it via the normal `openPath` flow (the
 * same one every other "open a rig" entry point uses); one with no local
 * match is relay-only from here, and gets highlighted/scrolled to in the
 * rigs rail instead — NEVER a fake `openPath` call for a path this app
 * doesn't actually have.
 */
export type RigNameClickAction = { kind: 'open'; path: string } | { kind: 'highlight'; bindingId: string };

export function resolveRigNameClick(
  bindingId: string,
  localRigs: readonly { bindingId: string; path: string }[]
): RigNameClickAction {
  const local = localRigs.find((r) => r.bindingId === bindingId);
  return local ? { kind: 'open', path: local.path } : { kind: 'highlight', bindingId };
}

// ── Round 2 — rigs-rail filter/sort (Dylan: calmer at 15+ rigs) ────────────

/**
 * `'shared'` mirrors `deriveRelayOnlyRowStatus`'s own role test (role !==
 * owner) — ownership, not availability; `'notSetUp'` is the OTHER axis
 * (no known local path yet, and not still checking) — a row can honestly
 * match both at once, this is a single-select VIEW filter, not a taxonomy
 * that has to partition the list.
 */
export function filterHomeRigRows(rows: readonly HomeRigRow[], filter: RigsRailFilter): HomeRigRow[] {
  switch (filter) {
    case 'all':
      return [...rows];
    case 'local':
      return rows.filter((r) => r.kind === 'local');
    case 'shared':
      return rows.filter((r) => r.kind === 'relayOnly' && r.role !== 'owner');
    case 'notSetUp':
      return rows.filter((r) => r.kind === 'relayOnly' && !r.localPathPending && r.localPath === null);
  }
}

/**
 * `'recent'` is a no-op — `buildHomeRigRows` already returns local rows
 * ordered by `localRecencyKey` descending, then relay-only rows
 * alphabetically (no honest recency signal for those — see
 * `localRecencyKey`'s own comment), which IS the "recent activity" view;
 * re-deriving it here would just risk disagreeing with that ordering.
 * `'name'` re-sorts every row alphabetically, mixed regardless of kind —
 * a genuinely different view ("just show me the list a-z"), not a subset
 * of the default order.
 */
export function sortHomeRigRows(rows: readonly HomeRigRow[], sort: RigsRailSort): HomeRigRow[] {
  if (sort === 'name') {
    return [...rows].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }
  return [...rows];
}
