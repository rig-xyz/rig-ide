import {
  connectSession,
  createChatState,
  pinTopMode,
  type ChatContext,
  type ChatState,
  type ChatView,
} from '@emdash/chat-ui';
import type { QueuedPrompt, TranscriptTurn } from '@emdash/core/acp/client';
import { action, computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import { AcpLiveSession, AcpStartError, asValueSource } from '@renderer/lib/acp/acp-live-session';
import { getSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import type { RigSessionTitleSource } from '@shared/rig/sessions';
import { deriveAutoApplyOption } from './model-preference';
import { shouldPersistMode } from './permission-mode';
import { decideSubmitDisposition, type SubmitDisposition } from './resume-presentation';
import {
  newTurnsSince,
  nextLastSeq,
  parseStoredEvents,
  shouldPersistTitle,
  withTurnTimestamps,
} from './session-writer';

/**
 * MobX store for one chat session against a bound rig's own workspace root.
 *
 * Stripped down from emdash-desktop's `AcpChatStore` (see
 * `apps/emdash-desktop/src/renderer/features/conversations/acp/acp-chat-store.ts`):
 * no task/project/workspace-registry lookups, no thread store, no issue
 * mentions, no prompt library, no attachments. `_startInput()` follows the
 * same cwd-based pattern `main/rig/comment-agent.ts` uses for headless
 * turns — this app has no emdash task/workspace DB behind an opened rig
 * folder, so `projectId`/`taskId` below are opaque labels (never validated
 * against a real project/task row), and `workspaceId` is the cwd itself so
 * concurrent sessions in the same rig share one agent process per provider.
 */

export interface RigChatAffordances {
  isWorking: boolean;
  canSubmit: boolean;
  canCancel: boolean;
}

type PermissionQueueItem = {
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type RigChatLoadError =
  | { kind: 'auth_required'; message: string }
  | { kind: 'generic'; message: string };

export class RigChatStore {
  /** Discriminant shared with `ReplayStore` — `chat-panel.tsx`'s tabs hold either. */
  readonly kind = 'live' as const;
  readonly chatContext: ChatContext;
  readonly chatState: ChatState;
  readonly createdAt = Date.now();

  session: AcpLiveSession | null = null;
  historyLoading = true;
  loadError: RigChatLoadError | null = null;
  draftText = '';
  /** First user-submitted line — used as the session-switcher label. */
  title: string | null = null;
  /**
   * Round S2+: whether `title` came from the user (a rename) or was
   * auto-derived from the first prompt. `submitPrompt`'s auto-titling
   * checks this via `shouldPersistTitle` before ever attempting to persist
   * a newly-derived title — see that function's own doc comment for why
   * this is a client-side optimization, not the only safety net (the
   * server enforces the same rule independently).
   */
  titleSource: RigSessionTitleSource = 'auto';
  /**
   * Round F ("resume must never blank the room"): true once ANY history —
   * local cache or the live/resumed snapshot — has been seeded into
   * `chatState.transcript` at least once in this store's lifetime. A
   * monotonic latch, never reset back to false (a retry after a resume
   * failure must keep showing what's already on screen, not blank it again)
   * — see `resume-presentation.ts`'s `deriveTranscriptPanelMode`, which this
   * gates: only a store that has NEVER shown anything still earns the
   * full-panel loading/error takeover.
   */
  hasSeededHistory = false;
  /**
   * True only while `AcpLiveSession.resume()` itself is in flight — the
   * quiet inline "resuming session…" status line's one signal. Never true
   * for a brand-new session's `create()` path (nothing to protect there,
   * see `hasSeededHistory`), and never a progress percentage: the wire's
   * `resumeSession` call is a single atomic round trip with no incremental
   * replay-progress signal to show (investigated for round F — see the
   * doc comment on `AcpLiveSession.resume()`).
   */
  resuming = false;

  private _view: ChatView | null = null;
  private _bootstrapPromise: Promise<void> | null = null;
  private _unsubs: Array<() => void> = [];
  /**
   * Follow-up round — "remember my last model/effort pick per harness"
   * (and, later, permission mode — see `setMode`'s own comment): the
   * remembered ids (read once from `rpc.rig.settings` in the constructor,
   * null while unset or for a resumed session where this never applies at
   * all — see the constructor's own comment), the one-shot guard flags
   * (`deriveAutoApplyOption`'s `alreadyApplied`), and the reaction
   * disposers. Kept OUT of `_unsubs` deliberately: `_subscribeLiveSession`
   * clears that array on every (re)bootstrap, and this reaction must
   * survive that — it only ever needs to fire once, for the life of this
   * store.
   */
  private _rememberedModelId: string | null = null;
  private _rememberedEffortId: string | null = null;
  private _rememberedModeId: string | null = null;
  private _appliedRememberedModel = false;
  private _appliedRememberedEffort = false;
  private _appliedRememberedMode = false;
  private _disposePreferenceReactions: Array<() => void> = [];
  /** The ACP session id to resume from — see `_startInput()`. Null for a brand-new session. */
  private readonly _resumeAcpSessionId: string | null;
  /**
   * Persistence watermark: the highest turn `seq` already round-tripped
   * through `appendEvents`. -1 means nothing persisted yet. See
   * `session-writer.ts`'s `newTurnsSince`/`nextLastSeq`.
   */
  private _lastPersistedSeq = -1;
  /** Turn seq → the `at` main stamped when it was persisted — what the timestamps UI reads. */
  private readonly _turnTimestamps = new Map<number, number>();
  /**
   * Round: eager session activation — the `rig_sessions` row-creation
   * guard. A session can now exist on the runtime with no message ever
   * sent (an eagerly-picked harness in a zero-state tab, or an explicit
   * Resume click) — connecting alone must never create a history/Continue
   * row for something nobody actually used. `_ensureSessionRowPromise`
   * memoizes `_ensureSessionRow`'s in-flight/settled RPC (fires at most
   * once per store, unless it failed — see that method's own doc comment);
   * `_pendingTitleToPersist` holds a title `submitPrompt` derived but
   * hasn't persisted yet, so it never races ahead of the row it targets —
   * see both methods' own doc comments.
   *
   * Correction round (A1): this used to be a plain boolean flag flipped
   * BEFORE the ensure RPC was even issued, with `setTitle`/`appendEvents`
   * firing independently right after — a genuine race, not just a naming
   * quirk. Remembering the actual PROMISE (not just "was it started") lets
   * every write that targets this row chain onto the SAME ensure instead
   * of assuming it already landed.
   */
  private _ensureSessionRowPromise: Promise<void> | null = null;
  private _pendingTitleToPersist: string | null = null;
  /**
   * Immediate-feedback state (Round E): which option of which request the
   * user just clicked, before the server has confirmed resolution. Bridges
   * the real gap between "clicked" and `permissionQueue` actually clearing
   * (the runtime running the tool, the live `sessionState` update arriving)
   * — without this, that gap reads as a dead click. Scoped to a specific
   * `requestId` so it never carries over onto a later, unrelated request.
   */
  private _resolvingPermission: { requestId: string; optionId: string } | null = null;
  /**
   * Round F: prompts submitted before `this.session` exists (still
   * bootstrapping or resuming) — `submitPrompt` used to hand these straight
   * to `session?.sendPrompt(...)`, which silently no-ops on a null session,
   * genuinely losing whatever was typed. Held here in submit order instead;
   * `_flushHeldPrompts` dispatches every one of them, in order, the instant
   * `_runBootstrap` assigns `this.session`. See `resume-presentation.ts`'s
   * `decideSubmitDisposition` for the pure "hold vs send vs queue" call.
   */
  private _heldPrompts: string[] = [];

  constructor(
    readonly conversationId: string,
    readonly rigBindingId: string,
    readonly cwd: string,
    readonly providerId: string,
    /**
     * Set only by the "Resume session" action (`chat-panel.tsx`) — binds
     * this store to an already-persisted `rig_sessions` row instead of
     * starting a fresh one. `acpSessionId` drives the real ACP
     * `loadSession` path (`_startInput`); `title`/`titleSource` seed the
     * tab label (and whether auto-titling may still touch it) instantly,
     * instead of waiting for the first prompt or a fresh `getSession` read.
     */
    resume?: { acpSessionId: string; title: string | null; titleSource?: RigSessionTitleSource }
  ) {
    this.chatContext = getSharedChatContext();
    this.chatState = createChatState(this.chatContext, { uri: conversationId });
    this._resumeAcpSessionId = resume?.acpSessionId ?? null;
    if (resume?.title) this.title = resume.title;
    if (resume?.titleSource) this.titleSource = resume.titleSource;

    makeObservable<this, '_resolvingPermission' | '_heldPrompts'>(this, {
      session: observable.ref,
      historyLoading: observable,
      loadError: observable,
      titleSource: observable,
      draftText: observable,
      title: observable,
      hasSeededHistory: observable,
      resuming: observable,
      _resolvingPermission: observable.ref,
      _heldPrompts: observable.shallow,
      model: computed,
      modelOptions: computed,
      permissionMode: computed,
      permissionModeOptions: computed,
      effort: computed,
      effortOptions: computed,
      permissionQueue: computed,
      resolvingPermissionOptionId: computed,
      queuedPrompts: computed,
      pendingResumeSubmitCount: computed,
      affordances: computed,
      submitPrompt: action,
      stop: action,
      setModel: action,
      setMode: action,
      setEffort: action,
      resolvePermission: action,
      setDraftText: action,
      retry: action,
      rename: action,
    });

    // Only for a brand-new session — a resumed one already carries its own
    // past model/effort choice, which a remembered "usual preference" must
    // never override.
    if (!resume) this._initPreferenceMemory();
  }

  /**
   * Follow-up round on the model/effort picker — auto-apply the last
   * model/effort picked for this harness, exactly once, when this
   * session's options first arrive. Reads settings once (a local IPC round
   * trip, effectively instant next to the ACP adapter actually connecting
   * and reporting config — by the time `modelOptions`/`effortOptions` can
   * possibly go non-empty, this has already resolved in every real case),
   * tries an apply immediately in case options are somehow already there,
   * then reacts to catch the far more common case where they arrive later.
   * `deriveAutoApplyOption`'s own `alreadyApplied` guard is what actually
   * makes this "once" — the reaction may fire more than once (a `computed`
   * returning a fresh array reference re-triggers it even when the
   * content didn't change), but every fire after the first successful
   * apply is a guaranteed no-op.
   */
  private _initPreferenceMemory(): void {
    void rpc.rig.settings.get().then((settings) => {
      this._rememberedModelId = settings.lastModelByHarness[this.providerId] ?? null;
      this._rememberedEffortId = settings.lastEffortByHarness[this.providerId] ?? null;
      this._rememberedModeId = settings.lastModeByHarness[this.providerId] ?? null;
      this._tryApplyRememberedModel();
      this._tryApplyRememberedEffort();
      this._tryApplyRememberedMode();
      this._disposePreferenceReactions.push(
        reaction(
          () => this.modelOptions,
          () => this._tryApplyRememberedModel()
        ),
        reaction(
          () => this.effortOptions,
          () => this._tryApplyRememberedEffort()
        ),
        reaction(
          () => this.permissionModeOptions,
          () => this._tryApplyRememberedMode()
        )
      );
    });
  }

  private _tryApplyRememberedModel(): void {
    const id = deriveAutoApplyOption(this._rememberedModelId, this.modelOptions, this._appliedRememberedModel);
    if (!id) return;
    this._appliedRememberedModel = true;
    this.setModel(id);
  }

  /**
   * Same auto-apply-once mechanics as model/effort — nothing dangerous ever
   * reaches `_rememberedModeId` in the first place, since `setMode` only
   * ever writes a safe pick (`shouldPersistMode`) — so this never needs its
   * own danger check; a remembered id is safe by construction.
   */
  private _tryApplyRememberedMode(): void {
    const id = deriveAutoApplyOption(
      this._rememberedModeId,
      this.permissionModeOptions,
      this._appliedRememberedMode
    );
    if (!id) return;
    this._appliedRememberedMode = true;
    this.setMode(id);
  }

  private _tryApplyRememberedEffort(): void {
    const id = deriveAutoApplyOption(this._rememberedEffortId, this.effortOptions, this._appliedRememberedEffort);
    if (!id) return;
    this._appliedRememberedEffort = true;
    this.setEffort(id);
  }

  get model(): string | null {
    return this.session?.config.current().modelOptions?.selected ?? null;
  }

  get modelOptions(): { id: string; name: string }[] {
    return (this.session?.config.current().modelOptions?.available ?? []).map((o) => ({
      id: o.id,
      name: o.name,
    }));
  }

  get permissionMode(): string | null {
    return this.session?.config.current().modeOptions?.selected ?? null;
  }

  /**
   * `description` (round: permission mode control) is real, adapter-supplied
   * prose — confirmed against both bundled adapters' source
   * (`@agentclientprotocol/claude-agent-acp`'s `buildAvailableModes`,
   * `@agentclientprotocol/codex-acp`'s `AgentMode` — every mode of both
   * carries one) — surfaced as-is in the picker's dropdown rather than
   * paraphrased, since the adapter explains its own ladder better than
   * this app could guess at.
   */
  get permissionModeOptions(): { id: string; name: string; description?: string }[] {
    return (this.session?.config.current().modeOptions?.available ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
    }));
  }

  get effort(): string | null {
    return this.session?.config.current().efforts?.selected ?? null;
  }

  get effortOptions(): { id: string; name: string }[] {
    return (this.session?.config.current().efforts?.available ?? []).map((o) => ({
      id: o.id,
      name: o.name,
    }));
  }

  get permissionQueue(): PermissionQueueItem[] {
    return (this.session?.sessionState.current().pendingPermissions ?? []).map((request) => ({
      requestId: request.requestId,
      title: request.toolCall.title,
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    }));
  }

  /**
   * The option id the user just clicked for the CURRENT front-of-queue
   * request, if any — null once that request is gone (resolved, or
   * superseded by a different one), so a stale "resolving" state can never
   * leak onto an unrelated later request. See `_resolvingPermission`'s doc
   * comment for why this exists.
   */
  get resolvingPermissionOptionId(): string | null {
    const current = this.permissionQueue[0];
    if (!current || !this._resolvingPermission) return null;
    return this._resolvingPermission.requestId === current.requestId
      ? this._resolvingPermission.optionId
      : null;
  }

  get queuedPrompts(): QueuedPrompt[] {
    return this.session?.sessionState.current().queuedPrompts ?? [];
  }

  /** How many prompts are held for `_flushHeldPrompts`, waiting on the session to connect — see `_heldPrompts`. */
  get pendingResumeSubmitCount(): number {
    return this._heldPrompts.length;
  }

  get affordances(): RigChatAffordances {
    const state = this.session?.sessionState.current();
    return {
      isWorking: state?.isGenerating ?? false,
      canSubmit: state?.canSubmit ?? false,
      canCancel: state?.canCancel ?? false,
    };
  }

  /**
   * Idempotent — safe to call from every mount. Returns the in-flight (or
   * already-settled) bootstrap promise so a caller that needs to know when
   * the session is actually ready (the cockpit composer, sending the
   * message that starts a brand-new session) can await it instead of firing
   * a prompt at a session that doesn't exist on the runtime yet.
   */
  bootstrap(): Promise<void> {
    this._bootstrapPromise ??= this._runBootstrap();
    return this._bootstrapPromise;
  }

  retry(): void {
    if (this.historyLoading || !this.loadError) return;
    this.historyLoading = true;
    this.loadError = null;
    void this._runBootstrap();
  }

  bindView(view: ChatView | null): void {
    this._view = view;
  }

  submitPrompt(text: string): void {
    if (!text.trim()) return;
    const isWorking = this.affordances.isWorking;

    if (!isWorking) {
      const optimisticId = `optimistic:user:${Date.now()}`;
      this.chatState.session.setPendingPrompt({ id: optimisticId, text, attachments: [] });
      const pinMode = pinTopMode(optimisticId);
      this._view?.setScrollMode(pinMode);
      this.chatState.scroll.set(pinMode);
    }

    // `this.title` is set locally right away (the tab label updates
    // instantly, even mid-bootstrap) but the PERSISTED write is deferred to
    // `_dispatchPrompt` — it targets a `rig_sessions` row that may not
    // exist yet (see `_ensureSessionRow`'s own doc comment), and must
    // never race ahead of the write that creates it.
    const previousTitle = this.title;
    this.title ??= text.trim().split(/\r?\n/, 1)[0]?.slice(0, 80) || null;
    const newTitle = this.title;
    if (newTitle !== null && shouldPersistTitle(previousTitle, newTitle, this.titleSource)) {
      this._pendingTitleToPersist = newTitle;
    }

    // Round F: `this.session` is null throughout bootstrap/resume — this
    // used to fall straight to `session?.sendPrompt(...)`, which silently
    // no-ops on a null session, genuinely losing the message. Hold it
    // instead; `_flushHeldPrompts` dispatches it (and anything else typed
    // during the same window, in order) the moment the session connects.
    const disposition = decideSubmitDisposition({ sessionReady: this.session !== null, isWorking });
    if (disposition === 'hold') {
      this._heldPrompts.push(text);
      return;
    }
    this._dispatchPrompt(text, disposition);
  }

  /**
   * The real send/queue call to the runtime — `submitPrompt`'s non-`hold`
   * tail, and `_flushHeldPrompts`'s per-item dispatch. `this.session` is
   * guaranteed non-null here by construction (both callers only reach this
   * once `decideSubmitDisposition` has already confirmed it, or right
   * after `_runBootstrap` just assigned it).
   */
  private _dispatchPrompt(text: string, disposition: SubmitDisposition): void {
    if (disposition === 'hold') return; // unreachable: callers only pass 'send' | 'queue' here.
    // Row creation must land before any later write that targets this row
    // (the title persist right below, `appendEvents` later via
    // `_applyHistory`) — see `_ensureSessionRow`'s own doc comment. Chained
    // below, never awaited HERE: the actual prompt send must not wait on it.
    const ensured = this._ensureSessionRow();
    if (this._pendingTitleToPersist !== null) {
      const title = this._pendingTitleToPersist;
      this._pendingTitleToPersist = null;
      void ensured
        .then(() => rpc.rig.sessions.setTitle({ sessionId: this.conversationId, title }))
        .catch((error: unknown) => {
          console.error('Rig chat: failed to persist session title', {
            sessionId: this.conversationId,
            error,
          });
        });
    }
    const send =
      disposition === 'queue' ? this.session?.queuePrompt({ text }) : this.session?.sendPrompt({ text });
    void send
      ?.then((result) => {
        if (!result.success) this._toastError('Failed to send message', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to send message', error));
  }

  /**
   * "rig_sessions row created at session start" — but "start" now means
   * the first REAL dispatch, not merely connecting. Round: eager session
   * activation made it possible for a session to exist on the runtime
   * (model/effort pickers populated, composer fully armed) with no message
   * ever sent — an eagerly-picked harness in a zero-state tab, or an
   * explicit Resume click. Creating the row at connect time (the old
   * behavior) would make an untouched session show up in History/Continue,
   * which is the one thing this guard exists to prevent. Only ever KICKED
   * OFF from `_dispatchPrompt`, which only ever runs for a genuine
   * 'send'/'queue' — never 'hold' — so the underlying RPC fires exactly
   * once, exactly when the user has actually committed a message.
   * `_applyHistory` (below) also chains onto this same promise for its own
   * appends, but only when one is ALREADY in flight — it never triggers a
   * fresh ensure itself, preserving that same "no row for an untouched
   * session" invariant on the history-apply path too.
   *
   * A RESUMED session's row already exists from its earlier lifetime — not
   * calling this on a bare Resume-with-no-message click doesn't hide it or
   * leave anything orphaned, it just means `acpSessionId`/`updatedAt`
   * don't refresh until a real message is sent, which is the correct,
   * conservative default (no write for a session nobody has touched yet).
   *
   * Correction round (A1): memoized as the actual remembered PROMISE, not
   * a boolean flag flipped before the RPC even started — `setTitle` and
   * `appendEvents` used to fire independently right after this kicked off,
   * racing its own completion. A lost race silently dropped the title
   * (`setTitle`'s own `WHERE id = ?` guard just matches zero rows) or the
   * first turn's events (an FK violation against a not-yet-existing row,
   * caught and logged, never retried). Every write that targets this row
   * now chains onto the SAME promise instead. Never rejects: a genuine
   * `{ok:false}`/thrown failure is logged and un-memoized (round B fix —
   * the NEXT dispatch gets a fresh retry instead of a permanently latched
   * "done") but still resolves, so a chained write still runs — it's a
   * safe, idempotent no-op if the row still doesn't exist, exactly as
   * before this fix; only the RACE is closed here, not `ensureSession`'s
   * own best-effort reliability.
   */
  private _ensureSessionRow(): Promise<void> {
    if (!this._ensureSessionRowPromise) {
      this._ensureSessionRowPromise = rpc.rig.sessions
        .ensureSession({
          sessionId: this.conversationId,
          bindingId: this.rigBindingId,
          providerId: this.providerId,
          acpSessionId: this.session?.acpSessionId ?? null,
        })
        .then((result) => {
          if (result.ok) return;
          console.error('Rig chat: failed to record session start', {
            sessionId: this.conversationId,
            reason: result.reason,
          });
          this._ensureSessionRowPromise = null;
        })
        .catch((error: unknown) => {
          console.error('Rig chat: failed to record session start', {
            sessionId: this.conversationId,
            error,
          });
          this._ensureSessionRowPromise = null;
        });
    }
    return this._ensureSessionRowPromise;
  }

  /**
   * Runs once `_runBootstrap` assigns `this.session` — flushes every prompt
   * held while the session didn't exist yet, in submission order. Each is
   * re-evaluated against the CURRENT `isWorking` (a resumed session can come
   * back mid-generation), not assumed idle.
   */
  private _flushHeldPrompts(): void {
    for (const text of this._heldPrompts.splice(0)) {
      const disposition = decideSubmitDisposition({ sessionReady: true, isWorking: this.affordances.isWorking });
      this._dispatchPrompt(text, disposition);
    }
  }

  setDraftText(text: string): void {
    this.draftText = text;
  }

  /**
   * Explicit user rename (round S2+ — double-click a tab, or the History
   * list's rename affordance). Updates the local fields immediately (so the
   * tab strip/composer reflect it without waiting on a round trip) and
   * marks `titleSource` `'manual'` — from this point on, `submitPrompt`'s
   * auto-titling refuses to touch this store's title at all (see
   * `shouldPersistTitle`). Fire-and-forget like every other write here; the
   * server enforces the same manual-wins rule independently (`main/rig/
   * sessions.ts`'s `rename`/`setTitle`), so a dropped ack here still leaves
   * the DB row correct.
   */
  rename(title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.title = trimmed;
    this.titleSource = 'manual';
    void rpc.rig.sessions
      .rename({ sessionId: this.conversationId, title: trimmed })
      .catch((error: unknown) => this._toastError('Failed to rename the session', error));
  }

  stop(): void {
    void this.session
      ?.cancelTurn()
      .then((result) => {
        if (!result.success) this._toastError('Failed to stop', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to stop', error));
  }

  /**
   * Also remembers the pick for this harness (`lastModelByHarness`,
   * fire-and-forget) — whether this call came from the user's own click or
   * from `_tryApplyRememberedModel`'s own auto-apply, which just rewrites
   * the same value it read. Harmless either way, and simpler than telling
   * the two callers apart.
   */
  setModel(model: string): void {
    void rpc.rig.settings.set({ lastModelByHarness: { [this.providerId]: model } }).catch(() => {});
    void this.session
      ?.setModelOption('model', model)
      .then((result) => {
        if (!result.success) this._toastError('Failed to change model', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to change model', error));
  }

  /**
   * Round: permission-mode persistence — the every-session-resets rule was
   * deliberate for the SAFETY dimension of this control, but it reset
   * everything, which was never the actual intent (Dylan). Now remembers
   * the pick for this harness (`lastModeByHarness`, same fire-and-forget
   * shape as `setModel`/`setEffort`) — but ONLY when it's not dangerous
   * (`shouldPersistMode`): picking `bypassPermissions`/`agent-full-access`
   * never writes anything, so a session can never silently inherit "acts
   * without asking" from a past pick. A session with nothing safe
   * persisted still starts at the adapter's own default, unchanged.
   */
  setMode(modeId: string): void {
    if (shouldPersistMode(modeId)) {
      void rpc.rig.settings.set({ lastModeByHarness: { [this.providerId]: modeId } }).catch(() => {});
    }
    void this.session
      ?.setModeOption(modeId)
      .then((result) => {
        if (!result.success) this._toastError('Failed to change session mode', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to change session mode', error));
  }

  /** Same remember-for-next-time as `setModel` — see its own doc comment. */
  setEffort(effort: string): void {
    void rpc.rig.settings.set({ lastEffortByHarness: { [this.providerId]: effort } }).catch(() => {});
    void this.session
      ?.setModelOption('effort', effort)
      .then((result) => {
        if (!result.success) this._toastError('Failed to change effort', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to change effort', error));
  }

  resolvePermission(optionId: string): void {
    const request = this.permissionQueue[0];
    if (!request) return;
    // Immediate feedback (Round E) — set before the round trip, so the
    // click reads as progress rather than a dead click during whatever gap
    // there is before the runtime actually starts the tool.
    this._resolvingPermission = { requestId: request.requestId, optionId };
    void this.session
      ?.resolvePermission(request.requestId, optionId)
      .then((result) => {
        if (!result.success) {
          // The request is still sitting in `permissionQueue` (nothing
          // resolved it), so without clearing this, the buttons would stay
          // disabled forever on a false "running…" state with no way to
          // retry — worse than the pre-fix dead click.
          runInAction(() => (this._resolvingPermission = null));
          this._toastError('Failed to answer the permission request', result.error);
        }
      })
      .catch((error: unknown) => {
        runInAction(() => (this._resolvingPermission = null));
        this._toastError('Failed to answer the permission request', error);
      });
  }

  /**
   * Tears down this session for good — not a detach. Releases its hold on
   * the runtime worker's process (`AcpLiveSession.stopSession`, the same
   * refcounted-per-(provider,cwd) release `main/rig/comment-agent.ts` makes
   * when a headless turn finishes) before tearing down the local wire
   * subscriptions. Fire-and-forget like that call site: nothing here needs
   * to block removing the tab on the network round trip, and a runtime
   * that's already gone is not worth surfacing an error for.
   */
  dispose(): void {
    this._unsubs.splice(0).forEach((unsub) => unsub());
    this._disposePreferenceReactions.splice(0).forEach((dispose) => dispose());
    void this.session?.stopSession().catch(() => {});
    this.session?.dispose();
    // The final flush: everything already committed was persisted turn by
    // turn as it happened (see `_applyHistory`) — this only moves the row's
    // status, so `listSessions`/the History UI stop showing it as live.
    void rpc.rig.sessions.closeSession({ sessionId: this.conversationId }).catch((error: unknown) => {
      console.error('Rig chat: failed to close session', { sessionId: this.conversationId, error });
    });
    this.chatState.dispose();
  }

  private async _runBootstrap(): Promise<void> {
    try {
      // Establish the persistence watermark from whatever's already stored
      // — needed either way, so `_applyHistory` below never re-appends
      // turns we already have (`newTurnsSince`) — AND paint it immediately,
      // on a resume too (round F: "resume must never blank the room").
      //
      // This used to be skipped entirely on a resume (Round E's
      // `shouldSeedFromLocalHistory`), to avoid the adapter's replayed copy
      // landing on top of it and duplicating everything. That risk doesn't
      // apply to seeding alone, only to treating two sources as additive:
      // nothing else writes to `chatState.transcript` until
      // `_subscribeLiveSession` below (which only runs once resume/create
      // has fully resolved), and `_applyHistory` at the end of this method
      // always fully REPLACES whatever's on screen with the authoritative
      // snapshot regardless of what was seeded here — so painting the local
      // copy first is now purely a rendering head start, never a second
      // source that can double up.
      const stored = await rpc.rig.sessions
        .getEvents({ sessionId: this.conversationId })
        .catch((error: unknown) => {
          console.error('Rig chat: failed to read stored session events', {
            sessionId: this.conversationId,
            error,
          });
          return [];
        });
      const { turns: storedTurns, atBySeq: storedAt } = parseStoredEvents(stored);
      if (storedTurns.length > 0) {
        runInAction(() => {
          for (const [seq, at] of storedAt) this._turnTimestamps.set(seq, at);
          this._lastPersistedSeq = nextLastSeq(this._lastPersistedSeq, storedTurns);
          this.chatState.transcript.history.seed(withTurnTimestamps(storedTurns, this._turnTimestamps));
          this.hasSeededHistory = true;
        });
      }

      let clientSession: AcpLiveSession;
      let turns: readonly TranscriptTurn[];

      const resumeSessionId = this._resumeAcpSessionId;
      if (resumeSessionId) {
        // `resume()` blocks until the adapter's `loadSession` replay has
        // fully settled server-side and returns the result in that same
        // response — the one authoritative post-replay snapshot, applied
        // via `_applyHistory` below (a full replace) regardless of whatever
        // the local seed above already painted. `resuming` is the quiet
        // inline status line's one signal — see its own doc comment for why
        // it's not a progress percentage.
        runInAction(() => {
          this.resuming = true;
        });
        try {
          const resumed = await AcpLiveSession.resume(this.conversationId, {
            ...this._startInput(),
            sessionId: resumeSessionId,
          });
          clientSession = resumed.session;
          turns = resumed.history.turns;
        } finally {
          runInAction(() => {
            this.resuming = false;
          });
        }
      } else {
        clientSession = await AcpLiveSession.create(this.conversationId, this._startInput());
        const history = await clientSession.getHistory(undefined, 100);
        if (!history.success) throw resultError(history.error);
        turns = history.data.turns;
      }

      runInAction(() => {
        this.session?.dispose();
        this.session = clientSession;
        this._subscribeLiveSession(clientSession);
        this.historyLoading = false;
        this.loadError = null;
      });
      // The session now exists — dispatch anything typed while it didn't
      // (round F: this used to be a silent drop, see `_heldPrompts`).
      this._flushHeldPrompts();

      // NOTE: `ensureSession` (the `rig_sessions` row write) does NOT fire
      // here. Round: eager session activation — a session can now exist on
      // the runtime (eager harness pick, or an explicit Resume click) with
      // no message ever sent, and connecting alone must never create a
      // history/Continue row for something nobody actually used. It's
      // gated on a real dispatch instead — see `_ensureSessionRow`'s own
      // doc comment for exactly where.
      //
      // `_lastPersistedSeq` already reflects `storedTurns` from above, so a
      // resume's replayed turns (matching seq, per the adapter's replay
      // reconstruction) are correctly treated as "already have these" and
      // never re-appended — this is the persistence-writer half of the
      // dedup fix, independent of the UI-seeding half above.
      this._applyHistory(turns);
    } catch (error) {
      console.error('Rig chat bootstrap failed', {
        conversationId: this.conversationId,
        cwd: this.cwd,
        providerId: this.providerId,
        error,
      });
      runInAction(() => {
        this.historyLoading = false;
        this.loadError = toLoadError(error);
      });
    }
  }

  /**
   * See the class doc: `projectId`/`taskId` are opaque labels the wire schema
   * requires as plain strings (for logging + a best-effort DB lookup that is
   * a no-op here) — never validated against a real project/task row. No
   * `initialQueue`: unlike the headless comment-agent dispatch, an
   * interactive session starts empty and waits for the composer.
   *
   * `sessionId` carries the persisted ACP session id on a resume
   * (`_resumeAcpSessionId`) — the one thing that actually triggers the
   * runtime's `loadSession` path (`session-manager.ts`'s gate); null for a
   * brand-new session, unchanged from before Round B.
   */
  private _startInput() {
    return {
      conversationId: this.conversationId,
      projectId: this.rigBindingId,
      taskId: this.conversationId,
      providerId: this.providerId,
      workspaceId: this.cwd,
      cwd: this.cwd,
      sessionId: this._resumeAcpSessionId,
      model: null,
    };
  }

  private _subscribeLiveSession(session: AcpLiveSession): void {
    this._unsubs.splice(0).forEach((unsub) => unsub());
    const disconnectChatSession = connectSession(
      this.chatState,
      {
        activeTurn: asValueSource(session.activeTurn),
        plan: asValueSource(session.plan),
        sessionState: asValueSource(session.sessionState),
      },
      {
        onTurnCommitted: () => void this._refreshHistory(),
      }
    );
    this._unsubs.push(disconnectChatSession);
  }

  private async _refreshHistory(): Promise<void> {
    const history = await this.session?.getHistory(undefined, 100);
    if (!history?.success) return;
    runInAction(() => {
      this.chatState.session.setPendingPrompt(null);
    });
    this._applyHistory(history.data.turns);
  }

  /**
   * The one place committed turns become both persisted state and rendered
   * state. Computes the delta since `_lastPersistedSeq` (pure logic in
   * `session-writer.ts`), fires it off as one batched, fire-and-forget
   * `appendEvents` call — persistence must never block or slow down the
   * chat itself — and re-seeds the transcript immediately with whatever
   * timestamps are already known. Once the batch's ack lands, the newly
   * appended turns' timestamps backfill via a second, harmless re-seed.
   *
   * A dropped batch (main logs it; see `sessions.ts`) is not retried here —
   * retrying into a since-appended later batch would risk writing an older
   * batch's turns out of order behind it.
   */
  private _applyHistory(turns: readonly TranscriptTurn[]): void {
    const fresh = newTurnsSince(turns, this._lastPersistedSeq);
    if (fresh.length > 0) {
      this._lastPersistedSeq = nextLastSeq(this._lastPersistedSeq, fresh);
      // A1 fix: chain onto `_ensureSessionRow`'s OWN memoized promise if
      // one is already in flight — the real risk case is fresh turns
      // landing right after a dispatch, before that RPC has actually
      // completed. Never CALLS `_ensureSessionRow()` itself here, only
      // reads the field — a store that's never dispatched anything (a
      // resumed session's pre-existing history, or an untouched eager one
      // with nothing new to persist) must not trigger a fresh ensure just
      // because history got applied; see `_ensureSessionRow`'s own doc
      // comment for why that invariant matters.
      const afterEnsure = this._ensureSessionRowPromise ?? Promise.resolve();
      void afterEnsure
        .then(() =>
          rpc.rig.sessions.appendEvents({
            sessionId: this.conversationId,
            events: fresh.map((turn) => ({ seq: turn.seq, turn })),
          })
        )
        .then(({ at }) => {
          runInAction(() => {
            for (const turn of fresh) this._turnTimestamps.set(turn.seq, at);
            this.chatState.transcript.history.seed(
              withTurnTimestamps(this.chatState.transcript.history.get(), this._turnTimestamps)
            );
          });
        })
        .catch((error: unknown) => {
          console.error('Rig chat: dropped a batch of session events (not retried)', {
            sessionId: this.conversationId,
            seqs: fresh.map((t) => t.seq),
            error,
          });
        });
    }
    runInAction(() => {
      this.chatState.transcript.history.seed(withTurnTimestamps(turns, this._turnTimestamps));
      if (turns.length > 0) this.hasSeededHistory = true;
    });
  }

  private _toastError(title: string, error: unknown): void {
    toast({
      title,
      description: error instanceof Error ? error.message : undefined,
      variant: 'destructive',
    });
  }
}

function resultError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    const type = (error as { type?: unknown }).type;
    return new Error(typeof message === 'string' ? message : String(type ?? 'Unknown error'));
  }
  return new Error(String(error));
}

function toLoadError(error: unknown): RigChatLoadError {
  const message = error instanceof Error ? error.message : 'Failed to load chat.';
  if (error instanceof AcpStartError && error.errorType === 'auth_required') {
    return { kind: 'auth_required', message };
  }
  return { kind: 'generic', message };
}
