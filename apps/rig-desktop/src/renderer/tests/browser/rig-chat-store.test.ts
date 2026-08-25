import type { Result } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RigSessionEventsPage } from '@shared/rig/sessions';

/**
 * Round: eager session activation — the persistence guard.
 *
 * A session can now exist on the runtime (connected, model/effort options
 * populated) with no message ever sent: an eagerly-picked harness in a
 * zero-state tab, or an explicit Resume click with no text. Investigation
 * found `ensureSession` (the `rig_sessions` row write) fired at BOOTSTRAP
 * time, unconditionally — meaning every eager/resumed-but-unused session
 * would have shown up in History/Continue the instant it connected, before
 * this fix. `rig-chat-store.ts`'s `_ensureSessionRowOnce` now gates that
 * write on a genuine `_dispatchPrompt` call (`submitPrompt`'s non-hold
 * tail, or a flushed held prompt) — this proves it end to end, against the
 * real store, not just the gating condition in isolation.
 *
 * Lives under the `browser` project (real Chromium), same as
 * `replay-store.test.ts` — `RigChatStore` constructs the same
 * `chat-ui`-backed `ChatState`/`ChatContext` `ReplayStore` does, which
 * needs a real `document` (chat-ui's markdown entity table touches it at
 * module load).
 */

const mocks = vi.hoisted(() => ({
  ensureSession: vi.fn<() => Promise<{ ok: true } | { ok: false; reason: string }>>(),
  setTitle: vi.fn<() => Promise<void>>(),
  appendEvents: vi.fn<() => Promise<{ ok: true; at: number; persistedThroughSeq: number }>>(),
  getEventsPage:
    vi.fn<(input: { afterSeq?: number; limit: number }) => Promise<RigSessionEventsPage>>(),
  closeSession: vi.fn<() => Promise<void>>(),
  settingsGet: vi.fn<() => Promise<unknown>>(),
  settingsSet: vi.fn<() => Promise<unknown>>(),
  acpCreate: vi.fn(),
  acpResume: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      sessions: {
        ensureSession: (...args: unknown[]) => mocks.ensureSession(...(args as [])),
        setTitle: (...args: unknown[]) => mocks.setTitle(...(args as [])),
        appendEvents: (...args: unknown[]) => mocks.appendEvents(...(args as [])),
        getEventsPage: (...args: unknown[]) =>
          mocks.getEventsPage(...(args as [{ afterSeq?: number; limit: number }])),
        closeSession: (...args: unknown[]) => mocks.closeSession(...(args as [])),
      },
      settings: {
        get: (...args: unknown[]) => mocks.settingsGet(...(args as [])),
        set: (...args: unknown[]) => mocks.settingsSet(...(args as [])),
      },
    },
  },
}));

/** Mirrors `asValueSource` in `acp-live-session.ts` exactly (trivial, re-implemented rather than imported so this file stays independent of the real module, which is itself mocked below). */
function fakeValueSource<T>(value: T) {
  return { current: () => value, onChange: () => () => {} };
}

/**
 * Flushes pending microtasks — generously many ticks, so a chain like
 * `ensureSession().then(...).catch(...)` (`_ensureSessionRow`) → another
 * `.then(setTitle)`/`.then(appendEvents)` on top of it settles regardless
 * of its exact depth, rather than hardcoding a tick count tied to today's
 * specific implementation (which would silently under-flush and mask a
 * real regression the next time a `.then()`/`.catch()` gets added or
 * removed from that chain).
 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type FakeSessionConfig = {
  modelOptions: { available: { id: string; name: string }[]; selected: string } | null;
  modeOptions: { available: { id: string; name: string }[]; selected: string } | null;
  efforts: { available: { id: string; name: string }[]; selected: string } | null;
};

function fakeLiveSession(
  overrides: { acpSessionId?: string | null; config?: FakeSessionConfig } = {}
) {
  return {
    acpSessionId: overrides.acpSessionId ?? 'acp-live-1',
    sessionState: fakeValueSource({
      isGenerating: false,
      canSubmit: true,
      canCancel: false,
      pendingPermissions: [],
    }),
    config: fakeValueSource(
      overrides.config ?? { modelOptions: null, modeOptions: null, efforts: null }
    ),
    plan: fakeValueSource(null),
    activeTurn: fakeValueSource(null),
    getHistory: vi.fn().mockResolvedValue({ success: true, data: { turns: [], nextCursor: null } }),
    sendPrompt: vi
      .fn()
      .mockResolvedValue({ success: true, data: undefined } satisfies Result<unknown, unknown>),
    queuePrompt: vi
      .fn()
      .mockResolvedValue({ success: true, data: undefined } satisfies Result<unknown, unknown>),
    stopSession: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    setModelOption: vi
      .fn()
      .mockResolvedValue({ success: true, data: undefined } satisfies Result<unknown, unknown>),
    setModeOption: vi
      .fn()
      .mockResolvedValue({ success: true, data: undefined } satisfies Result<unknown, unknown>),
  };
}

vi.mock('@renderer/lib/acp/acp-live-session', () => ({
  AcpLiveSession: {
    create: (...args: unknown[]) => mocks.acpCreate(...(args as [])),
    resume: (...args: unknown[]) => mocks.acpResume(...(args as [])),
  },
  AcpStartError: class AcpStartError extends Error {},
  asValueSource: (replica: {
    current: () => unknown;
    onChange: (cb: () => void) => () => void;
  }) => ({
    getSnapshot: () => replica.current(),
    subscribe: (cb: () => void) => replica.onChange(cb),
  }),
}));

const { RigChatStore } = await import('../../features/chat/rig-chat-store');

const EMPTY_SETTINGS = {
  version: 1,
  theme: null,
  chatPanelWidth: null,
  chatPanelCollapsed: false,
  lastHarnessByRig: {},
  lastModelByHarness: {},
  lastEffortByHarness: {},
  lastModeByHarness: {},
  lastOpenTabsByRig: {},
  hasSeenOnboarding: true,
};

beforeEach(() => {
  // Sensible defaults every test can rely on without repeating itself;
  // individual tests override where the scenario needs something specific.
  mocks.getEventsPage.mockResolvedValue({ events: [], nextCursor: null });
  mocks.settingsGet.mockResolvedValue(EMPTY_SETTINGS);
  mocks.settingsSet.mockResolvedValue(EMPTY_SETTINGS);
  mocks.ensureSession.mockResolvedValue({ ok: true });
  mocks.setTitle.mockResolvedValue(undefined);
  mocks.appendEvents.mockResolvedValue({ ok: true, at: Date.now(), persistedThroughSeq: 0 });
  mocks.closeSession.mockResolvedValue(undefined);
  mocks.acpCreate.mockResolvedValue(fakeLiveSession());
  // `AcpLiveSession.resume()`'s real return shape is `{ session, history }`
  // (`_runBootstrap` reads `resumed.session`/`resumed.history.turns`) —
  // distinct from `.create()`, which returns the session directly.
  mocks.acpResume.mockResolvedValue({
    session: fakeLiveSession(),
    history: { turns: [], nextCursor: null },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('RigChatStore — the rig_sessions row-creation guard', () => {
  it('bootstrapping alone (no prompt ever sent) never creates a row — the eager-start / bare-Resume case', async () => {
    const store = new RigChatStore('conv-1', 'bnd-1', '/rig', 'claude');
    await store.bootstrap();

    expect(mocks.ensureSession).not.toHaveBeenCalled();

    void store.dispose();
    // Closing an unused eager tab still cleans up (stopSession/dispose) —
    // `closeSession` is safe to call even though no row was ever ensured
    // (an UPDATE against a nonexistent row is a harmless no-op server-side).
    await flush();
    expect(mocks.closeSession).toHaveBeenCalledWith({ sessionId: 'conv-1' });
    expect(mocks.ensureSession).not.toHaveBeenCalled();
  });

  it('a real dispatch after bootstrap creates the row exactly once, and the title persist never races ahead of it', async () => {
    mocks.acpCreate.mockResolvedValue(fakeLiveSession({ acpSessionId: 'acp-live-1' }));

    const store = new RigChatStore('conv-2', 'bnd-1', '/rig', 'claude');
    await store.bootstrap();

    store.submitPrompt('Fix the flaky test');
    await flush();

    expect(mocks.ensureSession).toHaveBeenCalledTimes(1);
    expect(mocks.ensureSession).toHaveBeenCalledWith({
      sessionId: 'conv-2',
      bindingId: 'bnd-1',
      providerId: 'claude',
      acpSessionId: 'acp-live-1',
    });
    expect(mocks.setTitle).toHaveBeenCalledTimes(1);
    // The row must exist before the title UPDATE that targets it lands.
    expect(mocks.ensureSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setTitle.mock.invocationCallOrder[0]!
    );

    // A second prompt must not re-ensure the row.
    store.submitPrompt('Another message');
    await flush();
    expect(mocks.ensureSession).toHaveBeenCalledTimes(1);

    void store.dispose();
  });

  it('typing while the session is still bootstrapping (the held-prompt path) also ensures the row before persisting the title', async () => {
    let resolveCreate!: (value: ReturnType<typeof fakeLiveSession>) => void;
    mocks.acpCreate.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );

    const store = new RigChatStore('conv-3', 'bnd-1', '/rig', 'claude');
    const bootstrapping = store.bootstrap();

    // Typed before the session connects — held, not lost (round F), and
    // must not touch `rig_sessions` yet either (nothing to ensure a row
    // against — `this.session` is still null).
    store.submitPrompt('Type this while still connecting');
    expect(mocks.ensureSession).not.toHaveBeenCalled();

    resolveCreate(fakeLiveSession());
    await bootstrapping;
    await flush();

    expect(mocks.ensureSession).toHaveBeenCalledTimes(1);
    expect(mocks.ensureSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setTitle.mock.invocationCallOrder[0]!
    );

    void store.dispose();
  });

  it('A1 — setTitle never fires ahead of a still-in-flight ensureSession, even when the RPC resolves out of order relative to when it was called', async () => {
    let resolveEnsure!: (value: { ok: true }) => void;
    mocks.ensureSession.mockReturnValue(
      new Promise((resolve) => {
        resolveEnsure = resolve;
      })
    );

    const store = new RigChatStore('conv-5', 'bnd-1', '/rig', 'claude');
    await store.bootstrap();

    store.submitPrompt('Race me');
    // `ensureSession` has been CALLED (kicked off) but its promise is
    // deliberately left unresolved — simulating the exact race A1 fixes:
    // an IPC round-trip that hasn't landed yet. Before this fix, `setTitle`
    // fired independently right here, uninstrumented against that.
    await flush();
    expect(mocks.ensureSession).toHaveBeenCalledTimes(1);
    expect(mocks.setTitle).not.toHaveBeenCalled();

    // The ensure RPC finally resolves (out of order relative to call time —
    // nothing else in this test raced ahead of it, by construction, since
    // `setTitle` was blocked on it the whole time).
    resolveEnsure({ ok: true });
    await flush();
    expect(mocks.setTitle).toHaveBeenCalledTimes(1);
    expect(mocks.setTitle).toHaveBeenCalledWith({ sessionId: 'conv-5', title: 'Race me' });

    void store.dispose();
  });

  it('A1 — a fresh turn (appendEvents) landing right after a dispatch also waits for the same in-flight ensureSession, closing the FK-violation race', async () => {
    let resolveEnsure!: (value: { ok: true }) => void;
    mocks.ensureSession.mockReturnValue(
      new Promise((resolve) => {
        resolveEnsure = resolve;
      })
    );

    const store = new RigChatStore('conv-6', 'bnd-1', '/rig', 'claude');
    await store.bootstrap();

    // Real dispatch — kicks off `_ensureSessionRow`, deliberately left
    // unresolved (see `resolveEnsure` above).
    store.submitPrompt('Trigger a turn');
    await flush();
    expect(mocks.ensureSession).toHaveBeenCalledTimes(1);

    // `_applyHistory` is where a live session's committed turns become an
    // `appendEvents` call (`_refreshHistory`, wired from `connectSession`'s
    // `onTurnCommitted` — real chat-ui runtime plumbing this fake harness
    // doesn't reconstruct). Reached directly here as the same private seam
    // the production path funnels through, to prove its OWN gate — the
    // `this._ensureSessionRowPromise ?? Promise.resolve()` line — without
    // needing to fake the entire turn-commit detection machinery.
    const turn = {
      id: 'turn-0',
      seq: 0,
      initiator: 'assistant',
      items: [{ kind: 'message', id: 'msg-0', seq: 0, role: 'assistant', text: 'hello' }],
    };
    (store as unknown as { _applyHistory: (turns: unknown[]) => void })._applyHistory([turn]);
    await flush();
    // The row still isn't confirmed to exist — the append must not have
    // fired yet. Before this fix there was no gate at all here: it would
    // have fired immediately, racing `ensureSession`'s own still-pending
    // insert.
    expect(mocks.appendEvents).not.toHaveBeenCalled();

    resolveEnsure({ ok: true });
    await flush();
    expect(mocks.appendEvents).toHaveBeenCalledTimes(1);
    expect(mocks.appendEvents).toHaveBeenCalledWith({
      sessionId: 'conv-6',
      events: [{ seq: 0, turn }],
    });

    void store.dispose();
  });

  it("a genuine resume (existing acpSessionId) does not ensure a row on its own — the row already exists from that session's earlier lifetime", async () => {
    mocks.acpResume.mockResolvedValue({
      session: fakeLiveSession({ acpSessionId: 'acp-resumed-1' }),
      history: { turns: [], nextCursor: null },
    });

    const store = new RigChatStore('conv-4', 'bnd-1', '/rig', 'claude', {
      acpSessionId: 'acp-resumed-1',
      title: 'A past session',
      titleSource: 'auto',
    });
    await store.bootstrap();

    expect(mocks.ensureSession).not.toHaveBeenCalled();
    void store.dispose();
  });
});

describe('RigChatStore — lifecycle invalidation', () => {
  it('ignores a stored-history completion after disposal', async () => {
    const events = deferred<RigSessionEventsPage>();
    mocks.getEventsPage.mockReturnValue(events.promise);
    const store = new RigChatStore('conv-dispose-history', 'bnd-1', '/rig', 'claude');
    const bootstrap = store.bootstrap();

    void store.dispose();
    events.resolve({
      events: [
        {
          seq: 0,
          at: 123,
          turn: {
            id: 'turn-late',
            seq: 0,
            initiator: 'user',
            items: [{ kind: 'message', id: 'message-late', seq: 0, role: 'user', text: 'late' }],
          },
        },
      ],
      nextCursor: null,
    });
    await bootstrap;

    expect(store.disposed).toBe(true);
    expect(store.session).toBeNull();
    expect(store.historyLoading).toBe(true);
    expect(store.chatState.transcript.history.get()).toEqual([]);
    expect(mocks.acpCreate).not.toHaveBeenCalled();
    void store.dispose();
  });

  it('disposes a create result that resolves after invalidation and never flushes held prompts', async () => {
    const created = deferred<ReturnType<typeof fakeLiveSession>>();
    mocks.acpCreate.mockReturnValue(created.promise);
    const store = new RigChatStore('conv-dispose-create', 'bnd-1', '/rig', 'claude');
    const bootstrap = store.bootstrap();
    store.submitPrompt('held until create');
    await flush();
    void store.dispose();

    const session = fakeLiveSession();
    created.resolve(session);
    await bootstrap;

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.stopSession).toHaveBeenCalledTimes(1);
    expect(session.sendPrompt).not.toHaveBeenCalled();
    expect(store.session).toBeNull();
    expect(store.pendingResumeSubmitCount).toBe(1);
  });

  it('disposes a resume result that resolves after invalidation', async () => {
    const resumed = deferred<{
      session: ReturnType<typeof fakeLiveSession>;
      history: { turns: []; nextCursor: null };
    }>();
    mocks.acpResume.mockReturnValue(resumed.promise);
    const store = new RigChatStore('conv-dispose-resume', 'bnd-1', '/rig', 'claude', {
      acpSessionId: 'acp-resume-late',
      title: 'Past session',
    });
    const bootstrap = store.bootstrap();
    await flush();
    void store.dispose();

    const session = fakeLiveSession({ acpSessionId: 'acp-resume-late' });
    resumed.resolve({ session, history: { turns: [], nextCursor: null } });
    await bootstrap;

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.stopSession).toHaveBeenCalledTimes(1);
    expect(store.session).toBeNull();
    expect(store.resuming).toBe(true);
  });

  it('disposes a created session when history resolves after invalidation', async () => {
    const history = deferred<Result<{ turns: []; nextCursor: null }, unknown>>();
    const session = fakeLiveSession();
    session.getHistory.mockReturnValue(history.promise);
    mocks.acpCreate.mockResolvedValue(session);
    const store = new RigChatStore('conv-dispose-get-history', 'bnd-1', '/rig', 'claude');
    const bootstrap = store.bootstrap();
    await flush();
    void store.dispose();

    history.resolve({ success: true, data: { turns: [], nextCursor: null } });
    await bootstrap;

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.stopSession).toHaveBeenCalledTimes(1);
    expect(store.session).toBeNull();
  });

  it('releases a created session when history acquisition fails before adoption', async () => {
    const session = fakeLiveSession();
    session.getHistory.mockResolvedValue({ success: false, error: new Error('history failed') });
    mocks.acpCreate.mockResolvedValue(session);
    const store = new RigChatStore('conv-history-failure', 'bnd-1', '/rig', 'claude');

    await store.bootstrap();

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.stopSession).toHaveBeenCalledTimes(1);
    expect(store.session).toBeNull();
    expect(store.loadError?.kind).toBe('generic');
  });
});

/**
 * Items 7 + 8, post-release usage round (Dylan): (7) permission mode now
 * persists per harness too — same `lastModelByHarness` pattern, but ONLY
 * for a safe pick, never a dangerous one. (8) Dylan suspected "the other
 * settings [model/effort] don't [persist] either" — this traces a REAL
 * new-session flow against the actual store (not just
 * `deriveAutoApplyOption` in isolation, already covered by
 * `model-preference.test.ts`) to confirm or refute that end to end.
 */
describe('RigChatStore — model/effort/mode preference memory, end to end', () => {
  const POPULATED_CONFIG: FakeSessionConfig = {
    modelOptions: {
      available: [
        { id: 'sonnet', name: 'Sonnet' },
        { id: 'haiku', name: 'Haiku' },
      ],
      selected: 'sonnet',
    },
    efforts: {
      available: [
        { id: 'low', name: 'low' },
        { id: 'high', name: 'high' },
      ],
      selected: 'low',
    },
    modeOptions: {
      available: [
        { id: 'default', name: 'Default' },
        { id: 'acceptEdits', name: 'Accept edits' },
      ],
      selected: 'default',
    },
  };

  it('evidence: a remembered model/effort/mode for this harness DOES genuinely apply once the new session reports its options — not just in the pure decision function, against the real store', async () => {
    mocks.settingsGet.mockResolvedValue({
      ...EMPTY_SETTINGS,
      lastModelByHarness: { claude: 'haiku' },
      lastEffortByHarness: { claude: 'high' },
      lastModeByHarness: { claude: 'acceptEdits' },
    });
    const session = fakeLiveSession({ config: POPULATED_CONFIG });
    mocks.acpCreate.mockResolvedValue(session);

    const store = new RigChatStore('conv-pref-1', 'bnd-1', '/rig', 'claude');
    await store.bootstrap();
    await flush();

    expect(session.setModelOption).toHaveBeenCalledWith('model', 'haiku');
    expect(session.setModelOption).toHaveBeenCalledWith('effort', 'high');
    expect(session.setModeOption).toHaveBeenCalledWith('acceptEdits');

    void store.dispose();
  });

  it('nothing remembered for this harness — every option starts at whatever the adapter itself selected, no forced apply call', async () => {
    mocks.settingsGet.mockResolvedValue(EMPTY_SETTINGS);
    const session = fakeLiveSession({ config: POPULATED_CONFIG });
    mocks.acpCreate.mockResolvedValue(session);

    const store = new RigChatStore('conv-pref-2', 'bnd-1', '/rig', 'claude');
    await store.bootstrap();
    await flush();

    expect(session.setModelOption).not.toHaveBeenCalled();
    expect(session.setModeOption).not.toHaveBeenCalled();

    void store.dispose();
  });

  it('a resumed session never applies a remembered preference — it already carries its own past choice', async () => {
    mocks.settingsGet.mockResolvedValue({
      ...EMPTY_SETTINGS,
      lastModelByHarness: { claude: 'haiku' },
    });
    const session = fakeLiveSession({ config: POPULATED_CONFIG, acpSessionId: 'acp-resumed-pref' });
    mocks.acpResume.mockResolvedValue({ session, history: { turns: [], nextCursor: null } });

    const store = new RigChatStore('conv-pref-3', 'bnd-1', '/rig', 'claude', {
      acpSessionId: 'acp-resumed-pref',
      title: null,
    });
    await store.bootstrap();
    await flush();

    expect(session.setModelOption).not.toHaveBeenCalled();

    void store.dispose();
  });

  it('does not initialize remembered preferences after disposal', async () => {
    const settings = deferred<typeof EMPTY_SETTINGS>();
    mocks.settingsGet.mockReturnValue(settings.promise);
    const session = fakeLiveSession({ config: POPULATED_CONFIG });
    mocks.acpCreate.mockResolvedValue(session);

    const store = new RigChatStore('conv-pref-disposed', 'bnd-1', '/rig', 'claude');
    await store.bootstrap();
    void store.dispose();

    settings.resolve({
      ...EMPTY_SETTINGS,
      lastModelByHarness: { claude: 'haiku' },
      lastEffortByHarness: { claude: 'high' },
      lastModeByHarness: { claude: 'acceptEdits' },
    });
    await flush();

    expect(session.setModelOption).not.toHaveBeenCalled();
    expect(session.setModeOption).not.toHaveBeenCalled();
  });

  it('setMode persists a safe pick — item 7, "safe round-trips"', async () => {
    mocks.settingsGet.mockResolvedValue(EMPTY_SETTINGS);
    const session = fakeLiveSession({ config: POPULATED_CONFIG });
    mocks.acpCreate.mockResolvedValue(session);

    const store = new RigChatStore('conv-pref-4', 'bnd-1', '/rig', 'claude');
    await store.bootstrap();
    await flush();
    mocks.settingsSet.mockClear();

    store.setMode('acceptEdits');
    await flush();

    expect(mocks.settingsSet).toHaveBeenCalledWith({
      lastModeByHarness: { claude: 'acceptEdits' },
    });
    void store.dispose();
  });

  it('setMode never persists a dangerous pick — item 7, the whole point of the gate', async () => {
    mocks.settingsGet.mockResolvedValue(EMPTY_SETTINGS);
    const session = fakeLiveSession({ config: POPULATED_CONFIG });
    mocks.acpCreate.mockResolvedValue(session);

    const store = new RigChatStore('conv-pref-5', 'bnd-1', '/rig', 'claude');
    await store.bootstrap();
    await flush();
    mocks.settingsSet.mockClear();

    store.setMode('bypassPermissions');
    await flush();

    expect(mocks.settingsSet).not.toHaveBeenCalled();
    // The mode still applies to the live session — only the REMEMBERING is gated, never the pick itself.
    expect(session.setModeOption).toHaveBeenCalledWith('bypassPermissions');
    void store.dispose();
  });
});
