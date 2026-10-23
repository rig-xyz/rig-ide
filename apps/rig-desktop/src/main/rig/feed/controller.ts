import { events } from '@main/lib/events';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigFeedChangedChannel, type RigFeedSignal } from '@shared/rig/feed';
import { answerCard, getFeed, getSituation, hideCard, mergeSituations, moveEvent } from './relay';

/**
 * `rpc.rig.feed`: Home's Feed from the orchestrator. Writes tell the
 * renderer the Feed changed straight away; the relay's `feed_changed`
 * (notifications/service.ts) follows once the worker has re-decided.
 */
const changed = <T extends { success: boolean }>(r: T): T => {
  if (r.success) events.emit(rigFeedChangedChannel, { reason: 'local' });
  return r;
};

export const rigFeedController = createRPCController({
  get: () => getFeed(),
  situation: (input: { id: string }) => getSituation(input.id),
  answer: async (input: {
    situationId: string;
    signal: RigFeedSignal;
    choice?: string;
    until?: string;
  }) =>
    changed(
      await answerCard(input.situationId, input.signal, {
        choice: input.choice,
        until: input.until,
      })
    ),
  hide: async (input: { situationId: string; reason: string }) =>
    changed(await hideCard(input.situationId, input.reason, 'person')),
  merge: async (input: { keep: string; absorb: string[]; reason: string }) =>
    changed(await mergeSituations(input.keep, input.absorb, input.reason, 'person')),
  move: async (input: { eventId: string; to: string; reason: string }) =>
    changed(await moveEvent(input.eventId, input.to, input.reason, 'person')),
});
