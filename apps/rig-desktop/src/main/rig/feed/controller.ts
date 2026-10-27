import { err, ok } from '@emdash/shared';
import { events } from '@main/lib/events';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigFeedChangedChannel, type RigFeedSignal } from '@shared/rig/feed';
import { orchActions, sender } from '../orch/instance';
import { turnGate } from '../orch/turns';
import { getFeed, getSituation } from './relay';

/**
 * `rpc.rig.feed`: Home's Feed from the orchestrator. Every change goes
 * through the control plane (orch/actions.ts), the same functions the chat's
 * tools call, which tells the renderer the Feed changed.
 */
const ACTION: Record<RigFeedSignal, string> = { act: 'done', ignore: 'ignore', snooze: 'snooze' };

/** One act's outcome as the Feed's controls expect it. */
async function one(refs: string[], action: string, args: Record<string, unknown>) {
  const r = await orchActions.act({ refs, action, args, actor: 'person' });
  if (!r.success) return r;
  const failed = r.data.find((x) => !x.ok);
  return failed ? err({ kind: 'relay' as const, message: failed.message }) : ok(r.data);
}

export const rigFeedController = createRPCController({
  get: () => getFeed(),
  situation: (input: { id: string }) => getSituation(input.id),
  answer: (input: { situationId: string; signal: RigFeedSignal; choice?: string; until?: string }) =>
    one([input.situationId], ACTION[input.signal], { choice: input.choice, reason: input.choice, until: input.until }),
  hide: (input: { situationId: string; reason: string }) => one([input.situationId], 'hide', { reason: input.reason }),
  merge: (input: { keep: string; absorb: string[]; reason: string }) => one([input.keep, ...input.absorb], 'merge', { into: input.keep, reason: input.reason }),
  move: (input: { eventId: string; to: string; reason: string }) => one([input.eventId], 'move', { to: input.to, reason: input.reason }),
  /** The card's Start button: the person's click, so it gets a fresh turn id. */
  /**
   * A card's Send or Post: the person's click, so it gets a fresh turn id.
   * `choice` is its index on the card; `text` the words as they stand,
   * edited or not. Where they go is the card's own draft, read from Rig.
   */
  send: async (input: { situationId: string; choice: number; text: string }) => {
    const r = await sender.send(input, turnGate.issue('click'));
    if (r.success) events.emit(rigFeedChangedChannel, { reason: 'local' });
    return r.success ? ok(r.data) : err({ message: r.error });
  },
  /** `task`: the choice the person clicked, in the card's words; the brief's goal. `reply`: a card's Reply, which runs in Ask first. */
  start: async (input: { situationId: string; space?: string; task?: string; reply?: boolean }) => {
    const r = await orchActions.start({ ref: input.situationId, space: input.space, task: input.task, askFirst: input.reply === true, userTurnId: turnGate.issue('click') });
    // What's working changed, as a send changes the Feed: Home reads it again at once.
    if (r.success) events.emit(rigFeedChangedChannel, { reason: 'local' });
    return r;
  },
});
