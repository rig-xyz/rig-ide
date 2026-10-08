import type { DraftPreview } from '@main/rig/spaces-connection';
import { AGENT_NAME } from './components/identity';
import type { AgentKind } from './types';

/**
 * What the composer's send button does with a draft, and what it says.
 *
 * In order: an @tag of your agent asks it (unchanged from before routing);
 * a choice you made in the button's menu sticks for the draft; the one pill
 * for your agent without an @ (a reply to its turn, or its name first)
 * asks it; then the relay's routing (`DraftPreview.action`) asks your agent
 * when it says `ask`. Anything else is a plain send. Choosing Send yourself
 * while the relay would have asked or suggested your agent marks the
 * message `route: 'none'`, so the router leaves it alone.
 */

/** The relay's routing for a draft, as the composer uses it. `agent` is always one of yours. */
export type ComposerRoute = { action: 'ask' | 'suggest' | 'none'; agent: AgentKind | null };

/** What you picked in the send button's menu for this draft. */
export type SendOverride = { kind: 'agent'; agent: AgentKind } | { kind: 'send' };

export type SendDecision = {
  label: string;
  mode: 'ask' | 'send';
  /** Your agent the message asks; null for a plain send. */
  agent: AgentKind | null;
  meta: { route?: 'none' };
  /** Your agent the draft is for, but it isn't set up on this Mac: the message goes as plain chat instead. */
  unavailable?: AgentKind;
};

/** The preview's routing, or null from a relay that doesn't route (no `action`): the composer behaves as it always did. */
export function routeFromPreview(preview: DraftPreview, selfUserId: string): ComposerRoute | null {
  if (!preview.action) return null;
  const recipient = preview.recipient;
  const agent = recipient?.kind === 'agent' && recipient.ownerUserId === selfUserId ? recipient.agent : null;
  // Asking or suggesting is only ever about your own agent.
  if (preview.action !== 'none' && !agent) return { action: 'none', agent: null };
  return { action: preview.action, agent };
}

export function decideSend(input: {
  text: string;
  /** Your agents this composer can ask. */
  ownAgents: readonly AgentKind[];
  /** Those of `ownAgents` that can run on this Mac; all of them without it. */
  runnable?: readonly AgentKind[];
  /** Your agent the draft @tags (and you kept the tag's pill). */
  tagged: AgentKind | null;
  /** Your agent the one no-@ pill names (a reply to its turn, or called by name). */
  pill: AgentKind | null;
  route: ComposerRoute | null;
  override: SendOverride | null;
  /** A Reply you chose is on: a plain send reads "Reply". */
  replying: boolean;
}): SendDecision {
  const plain = (meta: SendDecision['meta'] = {}): SendDecision => ({
    label: input.replying ? 'Reply' : 'Send',
    mode: 'send',
    agent: null,
    meta,
  });
  const ask = (agent: AgentKind): SendDecision => ({ label: `Ask ${AGENT_NAME[agent]}`, mode: 'ask', agent, meta: {} });
  const own = (agent: AgentKind | null | undefined): agent is AgentKind => !!agent && input.ownAgents.includes(agent);
  // An agent this Mac can't run: plain chat, and route none so the relay
  // doesn't file the request this Mac would never claim.
  const askOrPlain = (agent: AgentKind): SendDecision =>
    !input.runnable || input.runnable.includes(agent) ? ask(agent) : { ...plain({ route: 'none' }), unavailable: agent };

  if (!input.text.trim()) return plain();
  if (own(input.tagged)) return askOrPlain(input.tagged);
  if (input.override?.kind === 'agent' && own(input.override.agent)) return askOrPlain(input.override.agent);
  if (input.override?.kind === 'send') {
    const wouldRoute = input.route?.action === 'ask' || input.route?.action === 'suggest';
    return plain(wouldRoute ? { route: 'none' } : {});
  }
  if (own(input.pill)) return askOrPlain(input.pill);
  if (input.route?.action === 'ask' && own(input.route.agent)) return askOrPlain(input.route.agent);
  return plain();
}
