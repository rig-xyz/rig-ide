import type { AgentCliSource, AgentRunFailureReason } from '@shared/telemetry';
import { classifyProviderAnswer } from './comment-agent-answer-classify';

/**
 * Why an agent run failed, as one of a few fixed reasons for the
 * `agent_run_failed` event. Pure string work on text that stays on this
 * computer (the failure's own words, and the answer when a provider error
 * leaked into it); only the reason ever leaves.
 */

/** Model not available to this account or CLI, with nothing saying the CLI is too old. */
const MODEL_UNSUPPORTED =
  /model[^\n]{0,80}(?:not supported|unsupported|not found|does not exist|not available|isn't available|is not available)|(?:unknown|invalid|unsupported) model|model_not_found/i;
const AUTH =
  /\b401\b|unauthori[sz]ed|not (?:logged|signed) in|log ?in (?:again|required|first)|authenticat|invalid[_ ]api[_ ]key|api key[^\n]{0,30}(?:invalid|missing)|auth_required|token[^\n]{0,20}expired|credentials/i;
const RATE_LIMIT =
  /\b429\b|rate[ _-]?limit|too many requests|usage limit|quota|overloaded|\b529\b/i;
const NETWORK =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|fetch failed|network|offline|timed? ?out|could not (?:connect|reach)|can't reach/i;

export type AgentFailurePhase = 'start' | 'run' | 'stalled';

/**
 * Most specific first: an outdated CLI (the existing comment-agent
 * classifier's own patterns) before a model the account can't use, then
 * sign-in, rate limits, the network, and finally whether it never started.
 */
export function classifyAgentRunFailure(
  text: string,
  phase: AgentFailurePhase
): AgentRunFailureReason {
  if (phase === 'stalled') return 'stalled';
  const classified = text.trim() ? classifyProviderAnswer(text) : null;
  if (classified?.kind === 'failure' && classified.reason === 'model-unsupported')
    return 'outdated_cli';
  if (MODEL_UNSUPPORTED.test(text)) return 'model_unsupported';
  if (AUTH.test(text)) return 'auth';
  if (RATE_LIMIT.test(text)) return 'rate_limit';
  if (NETWORK.test(text)) return 'network';
  return phase === 'start' ? 'start_failed' : 'other';
}

/**
 * Where an agent CLI came from, by its resolved path. `node_modules` is
 * checked before Homebrew: a global npm install under Homebrew's node lives
 * in `/opt/homebrew/lib/node_modules`, and that's npm's copy, not a cask.
 */
export function agentCliSource(path: string | null | undefined): AgentCliSource | null {
  if (!path) return null;
  if (/ChatGPT\.app\//.test(path)) return 'chatgpt_app';
  if (
    /[\\/]node_modules[\\/]|[\\/]\.npm(?:-global)?[\\/]|[\\/]\.nvm[\\/]|[\\/]\.volta[\\/]|[\\/]pnpm[\\/]/.test(
      path
    )
  )
    return 'npm';
  if (/[\\/](?:opt[\\/]homebrew|homebrew|Cellar|Caskroom|linuxbrew)[\\/]/.test(path))
    return 'homebrew';
  return 'other';
}
