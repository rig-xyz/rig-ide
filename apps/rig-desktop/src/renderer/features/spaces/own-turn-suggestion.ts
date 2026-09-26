import type { DraftPreview } from '@main/rig/spaces-connection';
import type { ComposerSuggestion } from './components/composer';
import { AGENT_NAME } from './components/identity';
import { excerptOf } from './components/transcript-items';
import { projectSessionCard } from './projection';
import type { RoomSnapshot } from './types';

/**
 * The relay's draft preview as the composer's pills: only when it names the
 * session message of a finished turn of YOUR agent that this Room shows
 * (with an answer to reply to). `answersTo` is the relay message id of that
 * `kind:'session'` message; the run it names is read from the Room's own
 * snapshot, which for your runs is this computer's full copy (the owner
 * overlay) and for everyone else's the relay's.
 */
export function ownTurnSuggestion(
  snapshot: RoomSnapshot | null,
  selfUserId: string,
  preview: DraftPreview
): ComposerSuggestion | null {
  if (!snapshot || !preview.answersTo || !preview.agent) return null;
  const message = snapshot.messages.find((m) => m.id === preview.answersTo);
  if (message?.meta.kind !== 'session') return null;
  const meta = snapshot.sessionMetaByRun[message.meta.runId];
  if (!meta || meta.owner !== selfUserId || meta.agent !== preview.agent) return null;
  const answer = projectSessionCard(snapshot.sessionEventsByRun[meta.id] ?? []).finalAnswer;
  if (!answer) return null;
  return {
    agent: meta.agent,
    confidence: preview.confidence,
    replyTo: { id: message.id, authorId: meta.owner, label: `Your ${AGENT_NAME[meta.agent]}`, excerpt: excerptOf(answer) },
  };
}
