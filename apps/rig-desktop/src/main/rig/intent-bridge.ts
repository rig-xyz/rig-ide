import { basename } from 'node:path';
import {
  planStateSchema,
  sessionSummarySchema,
  transcriptTurnSchema,
  type PlanEntryStatus,
  type PlanState,
  type SessionSummary,
  type TranscriptTurn,
} from '@emdash/core/acp';
import type { Unsubscribe } from '@emdash/shared';
import { ReplicaState } from '@emdash/wire';
import { z } from 'zod';
import { initializeAcpRuntimeProcess, type AcpRuntimeClient } from '@main/core/acp/controller';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  rigTasksUpdateChannel,
  type RigIntentView,
  type RigTasksSnapshot,
  type RigUiStatus,
} from '@shared/rig/contract';
import { findBindingConfig, type RigBindingLocation } from './binding';
import { disposeReplicaSafely } from './intent-bridge-lifecycle';
import { intentContextFromTurn } from './intent-context';
import { clearAcpSessionStart, getAcpSessionStart } from './session-registry';

const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const IN_PROGRESS_SUMMARY = 'in progress';
const TOPIC_RETRY_BASE_MS = 500;
const TOPIC_RETRY_MAX_MS = 5_000;
const TOPIC_RETRY_WINDOW_MS = 60_000;

type SessionSummaryList = Record<string, SessionSummary>;
const sessionSummaryListSchema = z.record(z.string(), sessionSummarySchema);
const planReplicaSchema = planStateSchema.nullable();
const activeTurnReplicaSchema = transcriptTurnSchema.nullable();

type RelayIntent = {
  id: string;
  title: string | null;
  agent: string | null;
  status: string;
  summaryText: string | null;
  parentIntentId: string | null;
  createdAt: string | null;
  closedAt: string | null;
};

type ChildIntent = {
  id: string;
  entryStatus: PlanEntryStatus;
  /** Set once the intent reached a terminal relay status — never patched again. */
  terminal: 'closed' | 'abandoned' | null;
};

type ConversationTracker = {
  conversationId: string;
  providerId: string;
  cwd: string | null;
  /** Binding lookup runs once, on the first prompt or non-null plan. */
  bindingResolved: boolean;
  binding: RigBindingLocation | null;
  sessionIntentId: string | null;
  promptTitleApplied: boolean;
  lastSummaryText: string | null;
  activeTurnSeq: number | null;
  liveAssistantText: string | null;
  summarizedTurnSeq: number | null;
  sawPlan: boolean;
  ended: boolean;
  children: Map<string, ChildIntent>;
  /** Serializes relay writes; plan updates can outpace HTTP round-trips. */
  queue: Promise<void>;
  planReplica: ReplicaState<PlanState | null> | null;
  planRetryTimer: NodeJS.Timeout | null;
  planRetryAttempts: number;
  planRetryStartedAt: number | null;
  planAttachWarned: boolean;
  planGaveUp: boolean;
  activeTurnReplica: ReplicaState<TranscriptTurn | null> | null;
  activeTurnRetryTimer: NodeJS.Timeout | null;
  activeTurnRetryAttempts: number;
  activeTurnRetryStartedAt: number | null;
  activeTurnAttachWarned: boolean;
  activeTurnGaveUp: boolean;
};

class RigIntentBridge {
  private client: AcpRuntimeClient | null = null;
  private readonly conversations = new Map<string, ConversationTracker>();
  private summariesReplica: ReplicaState<SessionSummaryList> | null = null;
  private processExitUnsubscribe: Unsubscribe | null = null;
  private activeBinding: RigBindingLocation | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastIntents: RigIntentView[] = [];
  private disposed = false;

  initialize(): void {
    // Initial snapshot so the renderer panel is never blank.
    this.emitSnapshot({ connected: false, error: null, intents: [] });
    void this.attach().catch((error) => {
      log.warn('Rig intent bridge failed to attach to ACP runtime', { error: String(error) });
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.processExitUnsubscribe?.();
    this.processExitUnsubscribe = null;
    for (const tracker of this.conversations.values()) {
      if (tracker.planRetryTimer) {
        clearTimeout(tracker.planRetryTimer);
        tracker.planRetryTimer = null;
      }
      if (tracker.activeTurnRetryTimer) {
        clearTimeout(tracker.activeTurnRetryTimer);
        tracker.activeTurnRetryTimer = null;
      }
      if (tracker.planReplica) void disposeReplicaSafely(tracker.planReplica);
      tracker.planReplica = null;
      if (tracker.activeTurnReplica) void disposeReplicaSafely(tracker.activeTurnReplica);
      tracker.activeTurnReplica = null;
    }
    this.conversations.clear();
    if (this.summariesReplica) {
      void disposeReplicaSafely(this.summariesReplica);
      this.summariesReplica = null;
    }
  }

  private async attach(): Promise<void> {
    const handle = await initializeAcpRuntimeProcess();
    if (this.disposed) return;
    this.client = handle.client;
    this.processExitUnsubscribe = handle.process.onExit((exit) => {
      if (exit.willRestart) return;
      this.handleRuntimeExit();
    });
    const replica = new ReplicaState<SessionSummaryList>(
      handle.client.sessions.state(undefined, 'list'),
      {
        schema: sessionSummaryListSchema,
        onChange: (summaries) => this.syncConversations(summaries),
      }
    );
    await replica.ready;
    if (this.disposed) {
      void disposeReplicaSafely(replica);
      return;
    }
    this.summariesReplica = replica;
    this.syncConversations(replica.current());
  }

  private handleRuntimeExit(): void {
    for (const conversationId of [...this.conversations.keys()]) {
      this.endConversation(conversationId);
    }
    if (this.summariesReplica) {
      void disposeReplicaSafely(this.summariesReplica);
      this.summariesReplica = null;
    }
    this.client = null;
  }

  private syncConversations(summaries: SessionSummaryList): void {
    const seen = new Set<string>();
    for (const summary of Object.values(summaries)) {
      seen.add(summary.conversationId);
      const tracker = this.conversations.get(summary.conversationId);
      if (tracker) {
        this.maybeAttachPlan(tracker, summary);
        this.maybeAttachActiveTurn(tracker, summary);
      } else {
        this.track(summary);
      }
    }
    for (const conversationId of [...this.conversations.keys()]) {
      if (!seen.has(conversationId)) this.endConversation(conversationId);
    }
  }

  private track(summary: SessionSummary): void {
    if (!this.client) return;
    const start = getAcpSessionStart(summary.conversationId);
    const tracker: ConversationTracker = {
      conversationId: summary.conversationId,
      providerId: start?.providerId ?? summary.providerId,
      cwd: start?.cwd ?? null,
      bindingResolved: false,
      binding: null,
      sessionIntentId: null,
      promptTitleApplied: false,
      lastSummaryText: null,
      activeTurnSeq: null,
      liveAssistantText: null,
      summarizedTurnSeq: null,
      sawPlan: false,
      ended: false,
      children: new Map(),
      queue: Promise.resolve(),
      planReplica: null,
      planRetryTimer: null,
      planRetryAttempts: 0,
      planRetryStartedAt: null,
      planAttachWarned: false,
      planGaveUp: false,
      activeTurnReplica: null,
      activeTurnRetryTimer: null,
      activeTurnRetryAttempts: 0,
      activeTurnRetryStartedAt: null,
      activeTurnAttachWarned: false,
      activeTurnGaveUp: false,
    };
    this.conversations.set(summary.conversationId, tracker);
    this.maybeAttachPlan(tracker, summary);
    this.maybeAttachActiveTurn(tracker, summary);
  }

  /**
   * The runtime publishes a `sessions.list` summary with lifecycle 'starting'
   * BEFORE the session record and its per-session live topics exist (they are
   * created only once the provider connection is up), so subscribing to
   * `session.plan` at that point fails with UNKNOWN_TOPIC. Wait for the first
   * post-record lifecycle before attaching; attachPlan retries with backoff as
   * a safety net, and every list update re-attempts a missing attachment.
   */
  private maybeAttachPlan(tracker: ConversationTracker, summary: SessionSummary): void {
    if (tracker.ended || tracker.planReplica || tracker.planGaveUp) return;
    if (summary.lifecycle === 'starting') return;
    if (tracker.planRetryTimer) {
      clearTimeout(tracker.planRetryTimer);
      tracker.planRetryTimer = null;
    }
    this.attachPlan(tracker);
  }

  private attachPlan(tracker: ConversationTracker): void {
    const client = this.client;
    if (!client || this.disposed || tracker.ended || tracker.planReplica) return;
    const replica = new ReplicaState<PlanState | null>(
      client.session.state({ conversationId: tracker.conversationId }, 'plan'),
      {
        schema: planReplicaSchema,
        onChange: (plan) => this.enqueue(tracker, () => this.reconcile(tracker, plan)),
      }
    );
    tracker.planReplica = replica;
    replica.ready.then(
      () => {
        log.info('Rig intent bridge: following session plan', {
          conversationId: tracker.conversationId,
        });
      },
      (error: unknown) => {
        if (tracker.planReplica === replica) tracker.planReplica = null;
        void disposeReplicaSafely(replica);
        if (!tracker.planAttachWarned) {
          tracker.planAttachWarned = true;
          log.warn('Rig intent bridge failed to follow session plan; retrying', {
            conversationId: tracker.conversationId,
            error: String(error),
          });
        }
        this.schedulePlanRetry(tracker);
      }
    );
  }

  private schedulePlanRetry(tracker: ConversationTracker): void {
    if (this.disposed || tracker.ended || tracker.planReplica || tracker.planRetryTimer) return;
    tracker.planRetryStartedAt ??= Date.now();
    if (Date.now() - tracker.planRetryStartedAt > TOPIC_RETRY_WINDOW_MS) {
      tracker.planGaveUp = true;
      log.warn('Rig intent bridge gave up following session plan', {
        conversationId: tracker.conversationId,
      });
      return;
    }
    const delay = Math.min(
      TOPIC_RETRY_BASE_MS * 2 ** tracker.planRetryAttempts,
      TOPIC_RETRY_MAX_MS
    );
    tracker.planRetryAttempts += 1;
    tracker.planRetryTimer = setTimeout(() => {
      tracker.planRetryTimer = null;
      this.attachPlan(tracker);
    }, delay);
  }

  /** Follow the provider-neutral transcript so providers without ACP plans still expose intent. */
  private maybeAttachActiveTurn(tracker: ConversationTracker, summary: SessionSummary): void {
    if (tracker.ended || tracker.activeTurnReplica || tracker.activeTurnGaveUp) return;
    if (summary.lifecycle === 'starting') return;
    if (tracker.activeTurnRetryTimer) {
      clearTimeout(tracker.activeTurnRetryTimer);
      tracker.activeTurnRetryTimer = null;
    }
    this.attachActiveTurn(tracker);
  }

  private attachActiveTurn(tracker: ConversationTracker): void {
    const client = this.client;
    if (!client || this.disposed || tracker.ended || tracker.activeTurnReplica) return;
    const replica = new ReplicaState<TranscriptTurn | null>(
      client.session.state({ conversationId: tracker.conversationId }, 'activeTurn'),
      {
        schema: activeTurnReplicaSchema,
        onChange: (turn) => this.enqueue(tracker, () => this.reconcileTurn(tracker, turn)),
      }
    );
    tracker.activeTurnReplica = replica;
    replica.ready.then(
      () => {
        log.info('Rig intent bridge: following active session turn', {
          conversationId: tracker.conversationId,
        });
      },
      (error: unknown) => {
        if (tracker.activeTurnReplica === replica) tracker.activeTurnReplica = null;
        void disposeReplicaSafely(replica);
        if (!tracker.activeTurnAttachWarned) {
          tracker.activeTurnAttachWarned = true;
          log.warn('Rig intent bridge failed to follow active session turn; retrying', {
            conversationId: tracker.conversationId,
            error: String(error),
          });
        }
        this.scheduleActiveTurnRetry(tracker);
      }
    );
  }

  private scheduleActiveTurnRetry(tracker: ConversationTracker): void {
    if (
      this.disposed ||
      tracker.ended ||
      tracker.activeTurnReplica ||
      tracker.activeTurnRetryTimer
    ) {
      return;
    }
    tracker.activeTurnRetryStartedAt ??= Date.now();
    if (Date.now() - tracker.activeTurnRetryStartedAt > TOPIC_RETRY_WINDOW_MS) {
      tracker.activeTurnGaveUp = true;
      log.warn('Rig intent bridge gave up following active session turn', {
        conversationId: tracker.conversationId,
      });
      return;
    }
    const delay = Math.min(
      TOPIC_RETRY_BASE_MS * 2 ** tracker.activeTurnRetryAttempts,
      TOPIC_RETRY_MAX_MS
    );
    tracker.activeTurnRetryAttempts += 1;
    tracker.activeTurnRetryTimer = setTimeout(() => {
      tracker.activeTurnRetryTimer = null;
      this.attachActiveTurn(tracker);
    }, delay);
  }

  private endConversation(conversationId: string): void {
    const tracker = this.conversations.get(conversationId);
    if (!tracker) return;
    this.conversations.delete(conversationId);
    clearAcpSessionStart(conversationId);
    if (tracker.planRetryTimer) {
      clearTimeout(tracker.planRetryTimer);
      tracker.planRetryTimer = null;
    }
    if (tracker.activeTurnRetryTimer) {
      clearTimeout(tracker.activeTurnRetryTimer);
      tracker.activeTurnRetryTimer = null;
    }
    if (tracker.planReplica) {
      void disposeReplicaSafely(tracker.planReplica);
      tracker.planReplica = null;
    }
    if (tracker.activeTurnReplica) {
      void disposeReplicaSafely(tracker.activeTurnReplica);
      tracker.activeTurnReplica = null;
    }
    this.enqueue(tracker, () => this.finish(tracker));
  }

  private enqueue(tracker: ConversationTracker, work: () => Promise<void>): void {
    tracker.queue = tracker.queue.then(work).catch((error) => {
      log.warn('Rig intent bridge relay task failed', {
        conversationId: tracker.conversationId,
        error: String(error),
      });
    });
  }

  private async reconcile(tracker: ConversationTracker, plan: PlanState | null): Promise<void> {
    if (tracker.ended) return;
    if (!plan) {
      // The plan live state starts null; only a null AFTER a real plan means done.
      if (tracker.sawPlan) {
        await this.captureSettledTurn(tracker);
        await this.finish(tracker);
      }
      return;
    }
    tracker.sawPlan = true;

    const binding = this.resolveBinding(tracker);
    if (!binding) return;

    const sessionIntentId = await this.ensureSessionIntent(tracker, binding, null);

    const seen = new Set<string>();
    for (const entry of plan.entries) {
      if (seen.has(entry.content)) continue;
      seen.add(entry.content);
      let child = tracker.children.get(entry.content);
      if (!child) {
        const created = await this.createIntent(binding, {
          agent: tracker.providerId || 'agent',
          title: entry.content,
          parentIntentId: sessionIntentId,
        });
        child = { id: created.id, entryStatus: 'pending', terminal: null };
        tracker.children.set(entry.content, child);
      }
      await this.applyEntryStatus(binding, child, entry.status);
    }

    // Providers replace the whole list; entries that vanished were abandoned.
    for (const [content, child] of tracker.children) {
      if (seen.has(content) || child.terminal) continue;
      await this.patchIntent(binding, child.id, { status: 'abandoned' });
      child.terminal = 'abandoned';
    }
  }

  private async applyEntryStatus(
    binding: RigBindingLocation,
    child: ChildIntent,
    next: PlanEntryStatus
  ): Promise<void> {
    if (child.terminal || next === child.entryStatus) return;
    if (next === 'in_progress') {
      await this.patchIntent(binding, child.id, { summaryText: IN_PROGRESS_SUMMARY });
    } else if (next === 'completed') {
      await this.closeIntent(binding, child.id);
      child.terminal = 'closed';
    }
    child.entryStatus = next;
  }

  /**
   * A prompt is the universal intent signal. ACP plans remain useful detail,
   * but Codex and other providers may complete a turn without ever publishing one.
   */
  private async reconcileTurn(
    tracker: ConversationTracker,
    turn: TranscriptTurn | null
  ): Promise<void> {
    if (tracker.ended) return;

    if (turn) {
      tracker.activeTurnSeq = turn.seq;
      const context = intentContextFromTurn(turn);
      if (context.summaryText) tracker.liveAssistantText = context.summaryText;

      const binding = this.resolveBinding(tracker);
      if (!binding) return;
      await this.ensureSessionIntent(tracker, binding, context.title);
      return;
    }

    await this.captureSettledTurn(tracker);
  }

  private async captureSettledTurn(tracker: ConversationTracker): Promise<void> {
    const turnSeq = tracker.activeTurnSeq;
    if (turnSeq === null || tracker.summarizedTurnSeq === turnSeq) return;

    const binding = this.resolveBinding(tracker);
    if (!binding || !tracker.sessionIntentId) return;

    const summaryText =
      (await this.readCommittedTurnSummary(tracker, turnSeq)) ?? tracker.liveAssistantText;
    if (summaryText && summaryText !== tracker.lastSummaryText) {
      await this.patchIntent(binding, tracker.sessionIntentId, { summaryText });
      tracker.lastSummaryText = summaryText;
    }
    tracker.summarizedTurnSeq = turnSeq;
    tracker.activeTurnSeq = null;
    tracker.liveAssistantText = null;
  }

  private async readCommittedTurnSummary(
    tracker: ConversationTracker,
    turnSeq: number
  ): Promise<string | null> {
    const client = this.client;
    if (!client) return null;
    try {
      const result = await client.getHistory({
        conversationId: tracker.conversationId,
        before: turnSeq + 1,
        limit: 1,
      });
      if (!result.success) {
        log.warn('Rig intent bridge could not read settled turn context', {
          conversationId: tracker.conversationId,
          turnSeq,
          error: result.error,
        });
        return null;
      }
      const settled = result.data.turns.find((candidate) => candidate.seq === turnSeq);
      return settled ? intentContextFromTurn(settled).summaryText : null;
    } catch (error) {
      log.warn('Rig intent bridge failed to read settled turn context', {
        conversationId: tracker.conversationId,
        turnSeq,
        error: String(error),
      });
      return null;
    }
  }

  private resolveBinding(tracker: ConversationTracker): RigBindingLocation | null {
    if (tracker.bindingResolved) return tracker.binding;

    tracker.bindingResolved = true;
    tracker.binding = tracker.cwd ? findBindingConfig(tracker.cwd) : null;
    if (tracker.binding) {
      this.setActiveBinding(tracker.binding);
    } else {
      log.info('Rig intent bridge: no rig workspace binding for session', {
        conversationId: tracker.conversationId,
        cwd: tracker.cwd,
      });
      if (!this.activeBinding) {
        this.emitSnapshot({
          connected: false,
          error: 'No rig workspace binding (.rig/tap-binding.local.json) found for this session',
          intents: [],
        });
      }
    }
    return tracker.binding;
  }

  private async ensureSessionIntent(
    tracker: ConversationTracker,
    binding: RigBindingLocation,
    promptTitle: string | null
  ): Promise<string> {
    if (!tracker.sessionIntentId) {
      const created = await this.createIntent(binding, {
        agent: tracker.providerId || 'agent',
        title: promptTitle ?? `Agent session — ${basename(binding.workspaceRoot)}`,
      });
      tracker.sessionIntentId = created.id;
      tracker.promptTitleApplied = promptTitle !== null;
      return created.id;
    }

    if (promptTitle && !tracker.promptTitleApplied) {
      await this.patchIntent(binding, tracker.sessionIntentId, { title: promptTitle });
      tracker.promptTitleApplied = true;
    }
    return tracker.sessionIntentId;
  }

  /** Session ended (plan cleared or session gone) — close the session intent and open children. */
  private async finish(tracker: ConversationTracker): Promise<void> {
    if (tracker.ended) return;
    tracker.ended = true;
    const binding = tracker.binding;
    if (!binding) return;
    for (const child of tracker.children.values()) {
      if (child.terminal) continue;
      await this.closeIntent(binding, child.id);
      child.terminal = 'closed';
    }
    if (tracker.sessionIntentId) {
      await this.patchIntent(binding, tracker.sessionIntentId, { status: 'closed' });
    }
  }

  private async closeIntent(binding: RigBindingLocation, intentId: string): Promise<void> {
    try {
      await this.patchIntent(binding, intentId, { status: 'closed', summaryText: null });
    } catch {
      // Some relay versions reject summaryText: null — the status alone suffices.
      await this.patchIntent(binding, intentId, { status: 'closed' });
    }
  }

  private async createIntent(
    binding: RigBindingLocation,
    body: { agent: string; title: string; parentIntentId?: string }
  ): Promise<{ id: string }> {
    const response = await this.relayFetch(
      binding,
      `/v1/bindings/${encodeURIComponent(binding.config.bindingId)}/intents`,
      { method: 'POST', body }
    );
    if (!response.ok) {
      throw new Error(`relay POST intent failed with status ${response.status}`);
    }
    const intent = (await response.json()) as { id?: unknown };
    if (typeof intent.id !== 'string') {
      throw new Error('relay POST intent returned no id');
    }
    return { id: intent.id };
  }

  /** Only ever called with intent ids this bridge created — PATCH is actor-scoped. */
  private async patchIntent(
    binding: RigBindingLocation,
    intentId: string,
    body: { status?: 'open' | 'closed' | 'abandoned'; title?: string; summaryText?: string | null }
  ): Promise<void> {
    const response = await this.relayFetch(
      binding,
      `/v1/bindings/${encodeURIComponent(binding.config.bindingId)}/intents/${encodeURIComponent(intentId)}`,
      { method: 'PATCH', body }
    );
    if (!response.ok) {
      throw new Error(`relay PATCH intent failed with status ${response.status}`);
    }
  }

  // Deliberately NOT behind the PAT trust gate (`relay-trust.ts`): this sends the
  // binding's OWN capability token to the binding's OWN relay — same trust domain,
  // nothing global to leak. Do not copy this pattern for `rpat_` PAT calls.
  private async relayFetch(
    binding: RigBindingLocation,
    path: string,
    init: { method: string; body?: unknown }
  ): Promise<Response> {
    const base = binding.config.relayUrl.replace(/\/+$/, '');
    return fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${binding.config.token}`,
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private setActiveBinding(binding: RigBindingLocation): void {
    this.activeBinding = binding;
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
      void this.poll();
    }
  }

  private async poll(): Promise<void> {
    const binding = this.activeBinding;
    if (!binding || this.disposed) return;
    try {
      const response = await this.relayFetch(
        binding,
        `/v1/bindings/${encodeURIComponent(binding.config.bindingId)}/intents?limit=200`,
        { method: 'GET' }
      );
      if (!response.ok) {
        throw new Error(`relay GET intents failed with status ${response.status}`);
      }
      const data = (await response.json()) as { intents?: RelayIntent[] };
      this.lastIntents = (data.intents ?? []).map(toIntentView);
      this.emitSnapshot({ connected: true, error: null, intents: this.lastIntents });
    } catch (error) {
      this.emitSnapshot({
        connected: false,
        error: String(error),
        intents: this.lastIntents,
      });
    }
  }

  private emitSnapshot(partial: Pick<RigTasksSnapshot, 'connected' | 'error' | 'intents'>): void {
    const binding = this.activeBinding;
    const snapshot: RigTasksSnapshot = {
      workspacePath: binding?.workspaceRoot ?? null,
      bindingId: binding?.config.bindingId ?? null,
      relayUrl: binding?.config.relayUrl ?? null,
      connected: partial.connected,
      error: partial.error,
      intents: partial.intents,
      updatedAt: Date.now(),
    };
    try {
      events.emit(rigTasksUpdateChannel, snapshot);
    } catch (error) {
      log.warn('Rig intent bridge failed to emit tasks snapshot', { error: String(error) });
    }
  }
}

function toIntentView(raw: RelayIntent): RigIntentView {
  const status: RigIntentView['status'] =
    raw.status === 'closed' || raw.status === 'abandoned' ? raw.status : 'open';
  const summaryText = raw.summaryText ?? null;
  return {
    id: String(raw.id),
    title: raw.title ?? '',
    agent: raw.agent ?? 'agent',
    status,
    uiStatus: toUiStatus(status, summaryText),
    summaryText,
    parentIntentId: raw.parentIntentId ?? null,
    createdAt: raw.createdAt ?? '',
    closedAt: raw.closedAt ?? null,
  };
}

function toUiStatus(status: RigIntentView['status'], summaryText: string | null): RigUiStatus {
  if (status === 'closed') return 'done';
  if (status === 'abandoned') return 'abandoned';
  return summaryText === IN_PROGRESS_SUMMARY ? 'doing' : 'todo';
}

const rigIntentBridge = new RigIntentBridge();

/** Wire the rig intent bridge into main-process startup. */
export function registerRigBridge(): void {
  rigIntentBridge.initialize();
}

export function disposeRigBridge(): void {
  rigIntentBridge.dispose();
}
