import { describe, expect, it } from 'vitest';
import {
  buildHomeRigRows,
  canAutoJoin,
  deriveHomeRegions,
  deriveRelayOnlyRowStatus,
  deriveWorkspacesState,
  disambiguateByName,
  filterHomeRigRows,
  groupSessionsByRig,
  localRecencyKey,
  resolveRigNameClick,
  sortHomeRigRows,
  type HomeRegionsInput,
  type HomeRigRow,
} from './home-sections';

const RIG_A = { bindingId: 'b1', name: 'Alpha', path: '/a', lastOpenedAt: 100 };
const RIG_B = { bindingId: 'b2', name: 'Beta', path: '/b', lastOpenedAt: 200 };
const SESSION_A = {
  id: 's1',
  providerId: 'claude',
  title: 'Fix the bug',
  updatedAt: 100,
  rigBindingId: 'b1',
  rigName: 'Alpha',
  rigPath: '/a',
};

const BASE: HomeRegionsInput = {
  signedIn: false,
  hasRunnableAgent: true,
  localRigs: [],
  recentSessions: [],
  workspaces: { status: 'skipped' },
};

describe('deriveHomeRegions', () => {
  it('nothing anywhere, signed out — the true empty state, no health line', () => {
    const regions = deriveHomeRegions(BASE);
    expect(regions).toEqual({ showRigs: false, showEmptyState: true, health: null });
  });

  it('signed in, no local data, workspaces resolved to zero bindings — still the empty state', () => {
    const regions = deriveHomeRegions({
      ...BASE,
      signedIn: true,
      workspaces: { status: 'ok', bindings: [] },
    });
    expect(regions.showEmptyState).toBe(true);
    expect(regions.showRigs).toBe(false);
  });

  it('a workspaces call still in flight never counts as empty on its own — rigs shows regardless (the rail carries local rigs immediately either way)', () => {
    const regions = deriveHomeRegions({ ...BASE, signedIn: true, workspaces: { status: 'loading' } });
    expect(regions.showEmptyState).toBe(false);
    expect(regions.showRigs).toBe(true);
  });

  it('local rigs alone are enough to leave the empty state, even signed out', () => {
    const regions = deriveHomeRegions({ ...BASE, localRigs: [RIG_A], recentSessions: [SESSION_A] });
    expect(regions.showEmptyState).toBe(false);
    expect(regions.showRigs).toBe(true);
    expect(regions.health).toEqual({ kind: 'signedOut', text: "Sign in to see your team's rigs" });
  });

  it('local + relay bindings, signed in and healthy — no health line at all', () => {
    const regions = deriveHomeRegions({
      signedIn: true,
      hasRunnableAgent: true,
      localRigs: [RIG_A],
      recentSessions: [SESSION_A],
      workspaces: {
        status: 'ok',
        bindings: [{ bindingId: 'b2', name: 'Beta', lastSyncedAt: null, role: 'editor', createdAt: '' }],
      },
    });
    expect(regions.showEmptyState).toBe(false);
    expect(regions.showRigs).toBe(true);
    expect(regions.health).toBeNull();
  });

  it('relay-only data alone (the invited-cofounder / solo case) is enough to leave the empty state — rigs still works with nothing local', () => {
    const regions = deriveHomeRegions({
      ...BASE,
      signedIn: true,
      workspaces: {
        status: 'ok',
        bindings: [{ bindingId: 'b2', name: 'Beta', lastSyncedAt: null, role: 'editor', createdAt: '' }],
      },
    });
    expect(regions.showEmptyState).toBe(false);
    expect(regions.showRigs).toBe(true);
  });

  it('no runnable agent takes priority over every other health message', () => {
    const regions = deriveHomeRegions({ ...BASE, localRigs: [RIG_A], hasRunnableAgent: false, signedIn: false });
    expect(regions.health?.kind).toBe('noAgent');
  });

  it('relay-unreachable only surfaces once signed in and an agent exists', () => {
    const regions = deriveHomeRegions({
      ...BASE,
      localRigs: [RIG_A],
      signedIn: true,
      hasRunnableAgent: true,
      workspaces: { status: 'unreachable' },
    });
    expect(regions.health).toEqual({ kind: 'relayUnreachable', text: 'offline · team rigs unavailable right now' });
  });
});

describe('groupSessionsByRig', () => {
  it('buckets sessions by rigBindingId, newest first within each bucket', () => {
    const grouped = groupSessionsByRig([
      { ...SESSION_A, id: 's1', updatedAt: 100 },
      { ...SESSION_A, id: 's2', updatedAt: 300 },
      { ...SESSION_A, id: 's3', updatedAt: 200 },
    ]);
    expect(grouped.get('b1')?.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
  });

  it('caps each rig at 3 sessions, keeping the most recent ones', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      ...SESSION_A,
      id: `s${i}`,
      updatedAt: i,
    }));
    const grouped = groupSessionsByRig(sessions);
    expect(grouped.get('b1')?.map((s) => s.id)).toEqual(['s4', 's3', 's2']);
  });

  it('a rig with no sessions has no entry at all (not an empty array key)', () => {
    const grouped = groupSessionsByRig([]);
    expect(grouped.has('b1')).toBe(false);
  });

  it('sessions from different rigs land in separate buckets', () => {
    const grouped = groupSessionsByRig([
      { ...SESSION_A, id: 's1', rigBindingId: 'b1' },
      { ...SESSION_A, id: 's2', rigBindingId: 'b2' },
    ]);
    expect(grouped.get('b1')?.map((s) => s.id)).toEqual(['s1']);
    expect(grouped.get('b2')?.map((s) => s.id)).toEqual(['s2']);
  });
});

describe('buildHomeRigRows', () => {
  it('a binding with a local match renders once, as the local row, carrying its sessions', () => {
    const rows = buildHomeRigRows(
      [RIG_A],
      {
        status: 'ok',
        bindings: [
          { bindingId: 'b1', name: 'Alpha (relay name)', lastSyncedAt: '2026-01-01T00:00:00Z', role: 'owner', createdAt: '2026-01-01T00:00:00Z' },
        ],
      },
      [SESSION_A]
    );
    expect(rows).toEqual([
      { kind: 'local', bindingId: 'b1', name: 'Alpha', path: '/a', lastOpenedAt: 100, sessions: [SESSION_A].map((s) => ({ id: s.id, providerId: s.providerId, title: s.title, updatedAt: s.updatedAt })) },
    ]);
  });

  it('a binding with no local match becomes its own relay-only row, carrying canAutoJoin, no localPath, and no sessions', () => {
    const rows = buildHomeRigRows(
      [],
      {
        status: 'ok',
        bindings: [{ bindingId: 'b2', name: 'Beta', lastSyncedAt: '2026-01-01T00:00:00Z', role: 'owner', createdAt: '2026-01-01T00:00:00Z' }],
      },
      []
    );
    expect(rows).toEqual([
      {
        kind: 'relayOnly',
        bindingId: 'b2',
        name: 'Beta',
        disambiguator: null,
        canAutoJoin: true,
        role: 'owner',
        localPath: null,
        localPathPending: false,
        sessions: [],
      },
    ]);
  });

  it('D7: localPathsPending threads through to every relay-only row uniformly (one query answers for all of them)', () => {
    const rows = buildHomeRigRows(
      [],
      {
        status: 'ok',
        bindings: [{ bindingId: 'b2', name: 'Beta', lastSyncedAt: '2026-01-01T00:00:00Z', role: 'owner', createdAt: '2026-01-01T00:00:00Z' }],
      },
      [],
      new Map(),
      true
    );
    expect(rows).toEqual([
      {
        kind: 'relayOnly',
        bindingId: 'b2',
        name: 'Beta',
        disambiguator: null,
        canAutoJoin: true,
        role: 'owner',
        localPath: null,
        localPathPending: true,
        sessions: [],
      },
    ]);
  });

  it('a rig chatted in recently outranks one merely opened earlier (session recency beats lastOpenedAt)', () => {
    const staleOpenButRecentChat = { bindingId: 'b3', name: 'Old-open', path: '/c', lastOpenedAt: 50 };
    const rows = buildHomeRigRows(
      [RIG_A, staleOpenButRecentChat], // RIG_A.lastOpenedAt = 100
      { status: 'skipped' },
      [{ ...SESSION_A, id: 's9', rigBindingId: 'b3', updatedAt: 9999 }]
    );
    expect(rows.map((r) => r.bindingId)).toEqual(['b3', 'b1']);
  });

  it('local rows sort by recency; relay-only rows follow, alphabetically (no honest recency signal for them)', () => {
    const rows = buildHomeRigRows(
      [RIG_A, RIG_B],
      {
        status: 'ok',
        bindings: [
          { bindingId: 'b4', name: 'Zeta', lastSyncedAt: null, role: 'owner', createdAt: '' },
          { bindingId: 'b3', name: 'Gamma', lastSyncedAt: null, role: 'owner', createdAt: '' },
        ],
      },
      []
    );
    expect(rows.map((r) => r.bindingId)).toEqual(['b2', 'b1', 'b3', 'b4']);
  });

  it('no bindings data (skipped/loading/unreachable) still renders local rows', () => {
    expect(buildHomeRigRows([RIG_A], { status: 'skipped' }, [])).toEqual([
      { kind: 'local', bindingId: 'b1', name: 'Alpha', path: '/a', lastOpenedAt: 100, sessions: [] },
    ]);
    expect(buildHomeRigRows([RIG_A], { status: 'unreachable' }, [])).toHaveLength(1);
    expect(buildHomeRigRows([RIG_A], { status: 'loading' }, [])).toHaveLength(1);
  });

  it('a bindingId returned twice by the relay collapses to one row (defensive dedupe)', () => {
    const rows = buildHomeRigRows(
      [],
      {
        status: 'ok',
        bindings: [
          { bindingId: 'b2', name: 'Beta', lastSyncedAt: null, role: 'owner', createdAt: '' },
          { bindingId: 'b2', name: 'Beta', lastSyncedAt: null, role: 'owner', createdAt: '' },
        ],
      },
      []
    );
    expect(rows).toHaveLength(1);
  });

  it('two DISTINCT bindingIds sharing a name are both kept, disambiguated by createdAt as subtext', () => {
    const rows = buildHomeRigRows(
      [],
      {
        status: 'ok',
        bindings: [
          { bindingId: 'bnd_aaaaaa111111', name: 'channel-test', lastSyncedAt: null, role: 'owner', createdAt: '2026-05-12T12:00:00Z' },
          { bindingId: 'bnd_bbbbbb222222', name: 'channel-test', lastSyncedAt: null, role: 'owner', createdAt: '2026-06-03T12:00:00Z' },
        ],
      },
      []
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'relayOnly' && r.name === 'channel-test')).toBe(true);
    const disambiguators = rows.map((r) => (r.kind === 'relayOnly' ? r.disambiguator : null));
    expect(disambiguators).toEqual(['created May 12', 'created Jun 3']);
  });

  it('a relay-only row with a discovered local path carries it, from the localPaths map', () => {
    const rows = buildHomeRigRows(
      [],
      {
        status: 'ok',
        bindings: [{ bindingId: 'b2', name: 'Beta', lastSyncedAt: null, role: 'editor', createdAt: '' }],
      },
      [],
      new Map([['b2', '/Users/dylan/Code/beta']])
    );
    expect(rows[0]).toMatchObject({ localPath: '/Users/dylan/Code/beta' });
  });
});

describe('disambiguateByName', () => {
  it('leaves a unique name untouched — no disambiguator at all', () => {
    const rows = disambiguateByName([{ bindingId: 'b1', name: 'Alpha', createdAt: '2026-05-12T12:00:00Z' }]);
    expect(rows[0].disambiguator).toBeNull();
  });

  it('attaches a "created <date>" subtext, never the bindingId, when two rows share a name', () => {
    const rows = disambiguateByName([
      { bindingId: 'bnd_111111', name: 'dup', createdAt: '2026-05-12T12:00:00Z' },
      { bindingId: 'bnd_222222', name: 'dup', createdAt: '2026-06-03T12:00:00Z' },
    ]);
    expect(rows.map((r) => r.disambiguator)).toEqual(['created May 12', 'created Jun 3']);
    expect(rows.every((r) => !r.disambiguator?.includes('111111') && !r.disambiguator?.includes('222222'))).toBe(
      true
    );
  });

  it('three-way collisions all get a disambiguator, not just the first two', () => {
    const rows = disambiguateByName([
      { bindingId: 'bnd_aaaaaa', name: 'x', createdAt: '2026-01-01T00:00:00Z' },
      { bindingId: 'bnd_bbbbbb', name: 'x', createdAt: '2026-02-01T00:00:00Z' },
      { bindingId: 'bnd_cccccc', name: 'x', createdAt: '2026-03-01T00:00:00Z' },
    ]);
    expect(rows.every((r) => r.disambiguator !== null)).toBe(true);
  });

  it('a missing/malformed createdAt degrades to no disambiguator — never an invented date', () => {
    const rows = disambiguateByName([
      { bindingId: 'bnd_111111', name: 'dup', createdAt: '' },
      { bindingId: 'bnd_222222', name: 'dup', createdAt: '2026-06-03T12:00:00Z' },
    ]);
    expect(rows[0].disambiguator).toBeNull();
    expect(rows[1].disambiguator).toBe('created Jun 3');
  });
});

describe('canAutoJoin', () => {
  it('is true for every real member role — rig attach is member-gated, not owner-gated', () => {
    expect(canAutoJoin('owner')).toBe(true);
    expect(canAutoJoin('editor')).toBe(true);
    expect(canAutoJoin('viewer')).toBe(true);
  });

  it('is false for an unrecognized role string rather than assuming the best', () => {
    expect(canAutoJoin('something-new')).toBe(false);
  });
});

describe('deriveRelayOnlyRowStatus', () => {
  it('checking wins over everything else — D7\'s pending third state', () => {
    expect(
      deriveRelayOnlyRowStatus({ localPathPending: true, localPath: null, role: 'owner' })
    ).toEqual({ kind: 'checking' });
    // Even a resolved localPath doesn't override a still-pending resolution
    // for this SAME query cycle — pending is applied uniformly (D7).
    expect(
      deriveRelayOnlyRowStatus({ localPathPending: true, localPath: '/somewhere', role: 'owner' })
    ).toEqual({ kind: 'checking' });
  });

  it('a known local path wins over role — the row is already set up, no icon/subtext needed', () => {
    expect(
      deriveRelayOnlyRowStatus({ localPathPending: false, localPath: '/found/it', role: 'editor' })
    ).toEqual({ kind: 'localPath', path: '/found/it' });
  });

  it('owner, not set up: no sharing claim — a fresh install\'s own rigs are relay-only too, never "shared with you"', () => {
    expect(
      deriveRelayOnlyRowStatus({ localPathPending: false, localPath: null, role: 'owner' })
    ).toEqual({ kind: 'notSetUp', sharedSubtext: null });
  });

  it('editor/viewer, not set up: the sharing claim is honest — someone else\'s rig, not yet set up here', () => {
    expect(
      deriveRelayOnlyRowStatus({ localPathPending: false, localPath: null, role: 'editor' })
    ).toEqual({ kind: 'notSetUp', sharedSubtext: 'shared with you' });
    expect(
      deriveRelayOnlyRowStatus({ localPathPending: false, localPath: null, role: 'viewer' })
    ).toEqual({ kind: 'notSetUp', sharedSubtext: 'shared with you' });
  });

  it('an unrecognized role keeps the sharing claim — same "unknown is not assumed to be owner" caution as canAutoJoin', () => {
    expect(
      deriveRelayOnlyRowStatus({ localPathPending: false, localPath: null, role: 'something-new' })
    ).toEqual({ kind: 'notSetUp', sharedSubtext: 'shared with you' });
  });
});

describe('resolveRigNameClick', () => {
  const localRigs = [
    { bindingId: 'b1', path: '/local/a' },
    { bindingId: 'b2', path: '/local/b' },
  ];

  it('opens the real local path for a rig this device already has', () => {
    expect(resolveRigNameClick('b1', localRigs)).toEqual({ kind: 'open', path: '/local/a' });
  });

  it('highlights instead of opening for a binding with no local match — never a fake path', () => {
    expect(resolveRigNameClick('relay-only-id', localRigs)).toEqual({
      kind: 'highlight',
      bindingId: 'relay-only-id',
    });
  });
});

describe('deriveWorkspacesState', () => {
  it('never calls out — skipped — when signed out, regardless of query state', () => {
    expect(deriveWorkspacesState(false, { isLoading: false, data: undefined })).toEqual({ status: 'skipped' });
  });

  it('loading while signed in and the query has not resolved yet', () => {
    expect(deriveWorkspacesState(true, { isLoading: true, data: undefined })).toEqual({ status: 'loading' });
  });

  it('ok, mapping id -> bindingId, on a successful result', () => {
    expect(
      deriveWorkspacesState(true, {
        isLoading: false,
        data: {
          success: true,
          data: [{ id: 'b1', name: 'Alpha', lastSyncedAt: null, role: 'owner', createdAt: '2026-05-12T12:00:00Z' }],
        },
      })
    ).toEqual({
      status: 'ok',
      bindings: [{ bindingId: 'b1', name: 'Alpha', lastSyncedAt: null, role: 'owner', createdAt: '2026-05-12T12:00:00Z' }],
    });
  });

  it('a relay error is unreachable', () => {
    expect(
      deriveWorkspacesState(true, { isLoading: false, data: { success: false, error: { kind: 'relay' } } })
    ).toEqual({ status: 'unreachable' });
  });

  it('an untrusted-relay error is unreachable too', () => {
    expect(
      deriveWorkspacesState(true, {
        isLoading: false,
        data: { success: false, error: { kind: 'untrustedRelay' } },
      })
    ).toEqual({ status: 'unreachable' });
  });

  it('a notSignedIn error degrades to skipped, not unreachable', () => {
    expect(
      deriveWorkspacesState(true, {
        isLoading: false,
        data: { success: false, error: { kind: 'notSignedIn' } },
      })
    ).toEqual({ status: 'skipped' });
  });
});

describe('localRecencyKey (round 2 — also the displayed last-activity time, not just the sort key)', () => {
  it('lastOpenedAt alone when there are no sessions', () => {
    expect(localRecencyKey({ lastOpenedAt: 100, sessions: [] })).toBe(100);
  });

  it('a fresher session beats an older lastOpenedAt', () => {
    expect(
      localRecencyKey({
        lastOpenedAt: 100,
        sessions: [{ id: 's1', providerId: 'claude', title: null, updatedAt: 500 }],
      })
    ).toBe(500);
  });

  it('lastOpenedAt wins when it is the more recent of the two', () => {
    expect(
      localRecencyKey({
        lastOpenedAt: 900,
        sessions: [{ id: 's1', providerId: 'claude', title: null, updatedAt: 500 }],
      })
    ).toBe(900);
  });

  it('takes the max across multiple sessions, not just the first/last', () => {
    expect(
      localRecencyKey({
        lastOpenedAt: 0,
        sessions: [
          { id: 's1', providerId: 'claude', title: null, updatedAt: 300 },
          { id: 's2', providerId: 'codex', title: null, updatedAt: 700 },
          { id: 's3', providerId: 'claude', title: null, updatedAt: 200 },
        ],
      })
    ).toBe(700);
  });
});

const LOCAL_ROW: HomeRigRow = {
  kind: 'local',
  bindingId: 'b1',
  name: 'Alpha',
  path: '/a',
  lastOpenedAt: 100,
  sessions: [],
};
const OWNED_NOT_SET_UP: HomeRigRow = {
  kind: 'relayOnly',
  bindingId: 'b2',
  name: 'Beta',
  disambiguator: null,
  canAutoJoin: true,
  role: 'owner',
  localPath: null,
  localPathPending: false,
  sessions: [],
};
const SHARED_NOT_SET_UP: HomeRigRow = {
  kind: 'relayOnly',
  bindingId: 'b3',
  name: 'Gamma',
  disambiguator: null,
  canAutoJoin: true,
  role: 'editor',
  localPath: null,
  localPathPending: false,
  sessions: [],
};
const SHARED_LOCAL_PATH_KNOWN: HomeRigRow = {
  kind: 'relayOnly',
  bindingId: 'b4',
  name: 'Delta',
  disambiguator: null,
  canAutoJoin: true,
  role: 'viewer',
  localPath: '/found/it',
  localPathPending: false,
  sessions: [],
};
const CHECKING: HomeRigRow = {
  kind: 'relayOnly',
  bindingId: 'b5',
  name: 'Epsilon',
  disambiguator: null,
  canAutoJoin: true,
  role: 'owner',
  localPath: null,
  localPathPending: true,
  sessions: [],
};

describe('filterHomeRigRows', () => {
  const rows = [LOCAL_ROW, OWNED_NOT_SET_UP, SHARED_NOT_SET_UP, SHARED_LOCAL_PATH_KNOWN, CHECKING];

  it('all — every row, unchanged order', () => {
    expect(filterHomeRigRows(rows, 'all')).toEqual(rows);
  });

  it('local — only kind local', () => {
    expect(filterHomeRigRows(rows, 'local')).toEqual([LOCAL_ROW]);
  });

  it('shared — role !== owner, regardless of whether it is set up locally (ownership axis, not availability)', () => {
    expect(filterHomeRigRows(rows, 'shared').map((r) => r.bindingId)).toEqual(['b3', 'b4']);
  });

  it('notSetUp — relay-only with no known local path AND not still checking', () => {
    expect(filterHomeRigRows(rows, 'notSetUp').map((r) => r.bindingId)).toEqual(['b2', 'b3']);
  });

  it('notSetUp excludes the checking (pending) state — honestly unknown, not yet "not set up"', () => {
    expect(filterHomeRigRows(rows, 'notSetUp')).not.toContainEqual(CHECKING);
  });
});

describe('sortHomeRigRows', () => {
  it('recent is a no-op — preserves buildHomeRigRows\'s own existing order', () => {
    const rows = [OWNED_NOT_SET_UP, LOCAL_ROW];
    expect(sortHomeRigRows(rows, 'recent')).toEqual(rows);
  });

  it('name sorts alphabetically across every kind mixed together', () => {
    const rows = [SHARED_NOT_SET_UP, LOCAL_ROW, OWNED_NOT_SET_UP]; // Gamma, Alpha, Beta
    expect(sortHomeRigRows(rows, 'name').map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});
