import { realpathSync } from 'node:fs';
import { localDependencyManager } from '@main/core/dependencies/dependency-managers';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { scrubModelId, scrubVersion } from '@main/lib/telemetry-scrub';
import type { AgentCli, AgentCliSource, DailyActiveAgentProps } from '@shared/telemetry';
import {
  agentCliSource,
  classifyAgentRunFailure,
  type AgentFailurePhase,
} from './agent-run-failure';

/**
 * The app-side half of `agent-run-failure.ts`: reads which CLI this computer
 * runs for an agent (the dependency probe's version and resolved path) and
 * sends `agent_run_failed`. Kept apart so the classifier stays pure.
 */

export function agentCliFacts(agent: AgentCli): {
  version: string | null;
  source: AgentCliSource | null;
} {
  const dep = localDependencyManager.get(agent);
  if (!dep?.path) return { version: scrubVersion(dep?.version), source: null };
  let resolved = dep.path;
  try {
    resolved = realpathSync(dep.path);
  } catch {
    // The probe's own path will do.
  }
  return { version: scrubVersion(dep.version), source: agentCliSource(resolved) };
}

export function reportAgentRunFailure(failure: {
  agent: AgentCli;
  /** The failure's own words and any answer text: read here to pick a reason, never sent. */
  text: string;
  phase: AgentFailurePhase;
  model?: string | null;
}): void {
  try {
    if (!telemetryService.canSendErrorReports()) return;
    const cli = agentCliFacts(failure.agent);
    const model = scrubModelId(failure.model);
    telemetryService.trackAgentRunFailed({
      agent: failure.agent,
      reason: classifyAgentRunFailure(failure.text, failure.phase),
      cli_version: cli.version,
      cli_source: cli.source,
      ...(model ? { model } : {}),
    });
  } catch (error) {
    log.warn('Rig: could not report an agent run failure', { error: String(error) });
  }
}

/** How long `daily_active_user` waits for the launch probe before going with whatever is known. */
const PROBE_WAIT_MS = 60_000;

/** `daily_active_user`'s agent fields, once `probe` (the launch dependency probe) has settled. */
export function dailyAgentCliInfo(probe: Promise<unknown>): () => Promise<DailyActiveAgentProps> {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      probe.catch(() => undefined),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, PROBE_WAIT_MS))),
    ]);
    clearTimeout(timer);
    const claude = agentCliFacts('claude');
    const codex = agentCliFacts('codex');
    return { claude_cli: claude.version, codex_cli: codex.version, codex_source: codex.source };
  };
}
