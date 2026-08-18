import { basename } from 'node:path';
import {
  planStateSchema,
  sessionSummarySchema,
  type PlanEntryStatus,
  type PlanState,
  type SessionSummary,
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
import { clearAcpSessionStart, getAcpSessionStart } from './session-registry';

const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const IN_PROGRESS_SUMMARY = 'in progress';
const PLAN_RETRY_BASE_MS = 500;
const PLAN_RETRY_MAX_MS = 5_000;
const PLAN_RETRY_WINDOW_MS = 60_000;

type SessionSummaryList = Record<string, SessionSummary>;
const sessionSummaryListSchema = z.record(z.string(), sessionSummarySchema);
const planReplicaSchema = planStateSchema.nullable();

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
  /** Binding lookup runs once, on the first non-null plan. */
  bindingResolved: boolean;
  binding: RigBindingLocation | null;
  sessionIntentId: string | null;
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
      if (tracker.planReplica) void tracker.planReplica.dispose();
      tracker.planReplica = null;
    }
    this.conversations.clear();
    if (this.summariesReplica) {
      void this.summariesReplica.dispose();
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
      void replica.dispose();
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
      void this.summariesReplica.dispose();
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
    };
    this.conversations.set(summary.conversationId, tracker);
    this.maybeAttachPlan(tracker, summary);
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
        void replica.dispose();
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
    if (Date.now() - tracker.planRetryStartedAt > PLAN_RETRY_WINDOW_MS) {
      tracker.planGaveUp = true;
      log.warn('Rig intent bridge gave up following session plan', {
        conversationId: tracker.conversationId,
      });
      return;
    }
    const delay = Math.min(PLAN_RETRY_BASE_MS * 2 ** tracker.planRetryAttempts, PLAN_RETRY_MAX_MS);
    tracker.planRetryAttempts += 1;
    tracker.planRetryTimer = setTimeout(() => {
      tracker.planRetryTimer = null;
      this.attachPlan(tracker);
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
    if (tracker.planReplica) {
      void tracker.planReplica.dispose();
      tracker.planReplica = null;
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
      if (tracker.sawPlan) await this.finish(tracker);
      return;
    }
    tracker.sawPlan = true;

    if (!tracker.bindingResolved) {
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
    }
    const binding = tracker.binding;
    if (!binding) return;

    if (!tracker.sessionIntentId) {
      const created = await this.createIntent(binding, {
        agent: tracker.providerId || 'agent',
        title: `Agent session — ${basename(binding.workspaceRoot)}`,
      });
      tracker.sessionIntentId = created.id;
    }

    const seen = new Set<string>();
    for (const entry of plan.entries) {
      if (seen.has(entry.content)) continue;
      seen.add(entry.content);
      let child = tracker.children.get(entry.content);
      if (!child) {
        const created = await this.createIntent(binding, {
          agent: tracker.providerId || 'agent',
          title: entry.content,
          parentIntentId: tracker.sessionIntentId,
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
