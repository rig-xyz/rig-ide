import { agentUpdateService } from '@main/core/dependencies/agent-update-service';
import { localDependencyManager } from '@main/core/dependencies/dependency-managers';
import { buildAgentPayloads } from '@main/core/agents/agent-payload-builder';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { rigAgentRunnabilityChangedChannel } from '@shared/rig/agents-status';
import { rigSettingsStore } from './settings-instance';

/**
 * Keeps two consumers honest about which agents are actually runnable
 * (harness-default round — Dylan's "opened a new rig, got CODEX"):
 *
 *  1. PERSISTS the live probe verdict to `settings.lastKnownRunnableAgents`
 *     whenever it changes. Probing is slow and uneven — measured on this
 *     machine: `claude --version` ~0.9s cold (a node CLI) vs `codex
 *     --version` ~40ms — so the renderer's zero-state used to commit its
 *     default before claude's probe ever landed. With the last KNOWN set
 *     persisted, the next boot can treat yesterday's runnable agents as
 *     available-for-default-selection immediately, while the live probe
 *     re-verifies in the background and this module corrects the set (and
 *     the persisted copy) if anything genuinely changed.
 *
 *  2. PUSHES `rigAgentRunnabilityChangedChannel` so the renderer
 *     invalidates its agents-list query the moment a late probe lands —
 *     previously nothing did, and a probe result arriving after the first
 *     `agents.list()` snapshot stayed invisible for up to the query's
 *     stale-time.
 *
 * Wired once at boot, BEFORE `probeAll()` fires, so no probe result can
 * slip between subscription and the initial sweep.
 */
export function wireAgentRunnabilityPersistence(): void {
  let lastPublished: string | null = null;
  let recomputeQueued = false;
  /**
   * B3 fix — monotonic, bumped each time a recompute actually starts its
   * (slow, uneven — see the module doc comment's ~40ms/~0.9s spread) probe
   * work. `recomputeQueued` only coalesces calls arriving DURING the 250ms
   * debounce window; it's already reset to `false` before
   * `buildAgentPayloads` even starts, so two overlapping recomputes (one
   * triggered early by a fast agent's status update, one triggered later
   * by a slow one) can race with no ordering guarantee on which resolves
   * first. Without this, whichever's `buildAgentPayloads()` call happened
   * to finish LAST won — even an earlier-started, slower recompute could
   * overwrite an already-published, genuinely NEWER result. Each
   * recompute captures its own generation right before probing; if a
   * newer one has since started by the time it resolves, its result is
   * simply discarded rather than published.
   */
  let generation = 0;

  const recompute = async () => {
    // Coalesce bursts: probeAll lands one status event per dependency.
    if (recomputeQueued) return;
    recomputeQueued = true;
    await new Promise((resolve) => setTimeout(resolve, 250));
    recomputeQueued = false;

    const myGeneration = ++generation;

    try {
      const payloads = await buildAgentPayloads(
        localDependencyManager.platform,
        localDependencyManager,
        (id, hostDep) => agentUpdateService.enrichHostDependency(id, hostDep)
      );
      // A newer recompute already started while this one was still
      // probing — its own result (once it resolves) is the authoritative
      // one; this stale one must never publish over it.
      if (myGeneration !== generation) return;

      const runnable = payloads
        .filter((payload) => payload.status === 'available')
        .map((payload) => payload.id)
        .sort();
      const key = runnable.join(',');
      if (key === lastPublished) return;
      lastPublished = key;

      const stored = rigSettingsStore.get().lastKnownRunnableAgents;
      if ([...stored].sort().join(',') !== key) {
        rigSettingsStore.set({ lastKnownRunnableAgents: runnable });
      }
      events.emit(rigAgentRunnabilityChangedChannel, { runnableAgents: runnable });
    } catch (error) {
      log.warn('Agent runnability: recompute failed', { error: String(error) });
    }
  };

  localDependencyManager.onStatusUpdated.subscribe(() => {
    void recompute();
  });
}
