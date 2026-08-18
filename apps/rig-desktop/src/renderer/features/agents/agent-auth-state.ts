/**
 * Pure state for the agent sign-in row (three honest states: probing →
 * signed in → not signed in) — shared by the onboarding agents step
 * (`agents-step.tsx`) and the Settings modal's Agents section
 * (`settings-modal.tsx`), the two places that render an installed agent's
 * row. Kept side-effect free so the state derivation is testable without
 * mocking the agent-config runtime client.
 *
 * `cliLoginMethod` is ported near-verbatim from emdash-desktop's
 * `renderer/features/onboarding/agent-step-state.ts` (read-only reference).
 */

import type { AgentAuthDescriptor, AgentAuthMethod, AgentAuthStatus } from '@emdash/core/agents/plugins';

export type CliLoginMethod = Extract<AgentAuthMethod, { kind: 'cli-login' }>;

/**
 * The agent's driveable CLI sign-in method, if it has one. Agents
 * authenticated by an API-key env var have none — which is why "not signed
 * in" can never be a hard blocker, only an offer.
 *
 * Takes just the `auth` descriptor (not the full `AgentCapabilities`, which
 * this never reads beyond it) — `AgentPayload.capabilities` still satisfies
 * this structurally, and it keeps test fixtures to the one field that
 * matters.
 */
export function cliLoginMethod(capabilities: { auth: AgentAuthDescriptor }): CliLoginMethod | null {
  if (capabilities.auth.kind !== 'supported') return null;
  const method = capabilities.auth.methods.find(
    (candidate): candidate is CliLoginMethod => candidate.kind === 'cli-login'
  );
  return method ?? null;
}

export type AgentAuthRowState =
  | { kind: 'noAuthSupport' }
  | { kind: 'probing' }
  | { kind: 'signedIn'; account: string | null }
  | { kind: 'notSignedIn' };

/**
 * Deliberate divergence from emdash's own row (which falls through to "not
 * signed in" while the probe is still in flight, then flips silently once
 * it resolves): this app's design system calls for honest states only, so
 * an agent with no probe result yet gets its own quiet `'probing'` state
 * rather than a guessed "not signed in" that might flip a moment later.
 *
 * `signedInOverride` is the sign-in dialog's own immediate flip on success —
 * checked ahead of `probeStatus` so the row shows "signed in" right away
 * rather than waiting on the invalidated query's refetch; once that refetch
 * lands with `probeData.kind === 'authenticated'`, its `account` (if any)
 * takes over from the override's account-less `null`.
 */
export function deriveAgentAuthRowState(input: {
  loginMethod: CliLoginMethod | null;
  signedInOverride: boolean;
  probeStatus: 'pending' | 'error' | 'success';
  probeData: AgentAuthStatus | null | undefined;
}): AgentAuthRowState {
  if (!input.loginMethod) return { kind: 'noAuthSupport' };
  if (input.signedInOverride || input.probeData?.kind === 'authenticated') {
    const account = input.probeData?.kind === 'authenticated' ? (input.probeData.account ?? null) : null;
    return { kind: 'signedIn', account };
  }
  if (input.probeStatus === 'pending') return { kind: 'probing' };
  return { kind: 'notSignedIn' };
}
