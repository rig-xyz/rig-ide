import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSpaceActivity } from '@renderer/features/notifications/use-notifications';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import type { RigNotification } from '@shared/rig/notifications';
import { approveOption, rejectOption } from './approval-options';
import {
  diffArrivals,
  computeForYou,
  requestKey,
  withoutRequests,
  type ForYou,
  type ForYouArrival,
  type ForYouSnapshot,
} from './for-you';
import { addDismissed, readDismissed } from './for-you-dismissed';
import type { RoomSnapshot } from './types';

/**
 * The Room's For you (`for-you.ts`): the model for this Space, the dismissals
 * kept on this computer, what just arrived, and answering a request.
 *
 * The inbox rows come from this Space's own page (`useSpaceActivity`: the
 * newest 100 direct rows of this Space), so a busy Space elsewhere cannot push
 * its asks out.
 *
 * Answering is optimistic. A request being answered leaves the model at once
 * (the badge, the pills, the panel) and stays out once the relay has taken the
 * answer, until the snapshot catches up. If the answer does not go through (the
 * call throws, or the run did not take it) the request comes back and a toast
 * says so. The same request is never sent twice.
 */

/** Where a request's answer is sent: the real RPC, or in the scripted demo the fixture. */
export type ResolvePermission = (
  runId: string,
  requestId: string,
  optionId: string
) => Promise<boolean>;

const resolveThroughRpc: ResolvePermission = async (runId, requestId, optionId) =>
  (await rpc.rig.spacesDispatch.resolvePermission({ runId, requestId, optionId })).resolved;

export type ForYouState = {
  forYou: ForYou;
  /**
   * The first look is done: the inbox and the Room have both loaded. What
   * For you holds before this is what was already there, not news.
   */
  ready: boolean;
  /**
   * What appeared in the latest change: a new ask, or a new pending request.
   * What was already there when the Room opened never shows up here. The
   * array changes identity only when something arrives, so an effect keyed on
   * it runs once per arrival.
   */
  arrivals: ForYouArrival[];
  /** Hides the ask the inbox row belongs to, for good on this computer. */
  dismiss: (notificationId: string) => void;
  /** Answers one request of one of your runs with its one-off allow. Settles once the answer went through or failed. */
  approve: (runId: string, requestId: string) => Promise<void>;
  /** Answers every pending request of a run with its one-off allow, in order, stopping at the first that fails. */
  approveAll: (runId: string) => Promise<void>;
  /** Answers one request with its deny. */
  reject: (runId: string, requestId: string) => Promise<void>;
};

type Answer = { runId: string; requestId: string; key: string; optionId: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function failureToast(verb: 'approve' | 'reject', answers: readonly Answer[], done: number): void {
  if (answers.length === 1) {
    toast({
      title: `Couldn’t ${verb} that request`,
      description:
        'Your answer did not reach your agent. The request is back in the list, so you can try again.',
    });
    return;
  }
  const left = answers.length - done;
  toast({
    title: 'Couldn’t approve all of them',
    description:
      done === 0
        ? 'Your answer did not reach your agent. The requests are back in the list, so you can try again.'
        : `${plural(done, 'request')} approved before it stopped. ${plural(left, 'request')} still waiting in the list.`,
  });
}

const NO_ARRIVALS: ForYouArrival[] = [];

export function useForYou(
  bindingId: string,
  snapshot: ForYouSnapshot & Pick<RoomSnapshot, 'loaded' | 'stale'>,
  selfUserId: string,
  options: {
    /** Rows to use instead of the inbox's (the scripted demo has no inbox). */
    notifications?: readonly RigNotification[];
    /** Where answers go instead of the real RPC (the scripted demo resolves them in its fixture). */
    resolvePermission?: ResolvePermission;
  } = {}
): ForYouState {
  const { notifications } = options;
  const spaceInbox = useSpaceActivity(bindingId, notifications === undefined);
  const activity = notifications ?? spaceInbox;
  // The Space's dismissals; another Space (the Room is not remounted) reads its own list.
  const [store, setStore] = useState(() => ({ bindingId, ids: readDismissed(bindingId) }));
  let current = store;
  if (store.bindingId !== bindingId) {
    current = { bindingId, ids: readDismissed(bindingId) };
    setStore(current);
  }
  const dismissed = useMemo(() => new Set(current.ids), [current.ids]);

  const { messages, members, sessionMetaByRun, sessionEventsByRun, sessionSummaryByRun } = snapshot;
  const modelled = useMemo(
    () =>
      computeForYou({
        snapshot: { messages, members, sessionMetaByRun, sessionEventsByRun, sessionSummaryByRun },
        selfUserId,
        notifications: activity ?? [],
        bindingId,
        dismissed,
      }),
    [
      messages,
      members,
      sessionMetaByRun,
      sessionEventsByRun,
      sessionSummaryByRun,
      selfUserId,
      activity,
      bindingId,
      dismissed,
    ]
  );

  // Requests being answered, or answered and waiting for the snapshot to show it: out of the model.
  const [answering, setAnswering] = useState<ReadonlyMap<string, 'sending' | 'sent'>>(new Map());
  const hidden = useMemo(() => new Set(answering.keys()), [answering]);
  const forYou = useMemo(() => withoutRequests(modelled, hidden), [modelled, hidden]);
  // Answered ones are forgotten once the snapshot no longer lists them.
  useEffect(() => {
    const listed = new Set(
      modelled.approvals.flatMap((a) => a.pending.map((p) => requestKey(a.runId, p.requestId)))
    );
    setAnswering((current) => {
      let next: Map<string, 'sending' | 'sent'> | null = null;
      for (const [key, state] of current) {
        if (state === 'sent' && !listed.has(key)) (next ??= new Map(current)).delete(key);
      }
      return next ?? current;
    });
  }, [modelled]);

  // Arrivals. The first look only counts what is there; it waits for the
  // inbox, and for a Room shown from disk to catch up, so what came in while
  // the app was closed is not announced as new.
  const ready = activity !== null && snapshot.loaded !== false && snapshot.stale !== true;
  const seenRef = useRef<Set<string> | null>(null);
  const seenFor = useRef(bindingId);
  const [arrivals, setArrivals] = useState<ForYouArrival[]>(NO_ARRIVALS);
  useEffect(() => {
    if (seenFor.current !== bindingId) {
      seenFor.current = bindingId;
      seenRef.current = null;
      setArrivals(NO_ARRIVALS);
    }
    if (!ready) return;
    const next = diffArrivals(seenRef.current, forYou);
    seenRef.current = next.seen;
    if (next.arrivals.length > 0) setArrivals(next.arrivals);
  }, [forYou, ready, bindingId]);

  const dismiss = useCallback(
    (notificationId: string) => {
      setStore({ bindingId, ids: addDismissed(bindingId, [notificationId]) });
    },
    [bindingId]
  );

  const resolveRef = useRef(options.resolvePermission ?? resolveThroughRpc);
  resolveRef.current = options.resolvePermission ?? resolveThroughRpc;
  /** Keys sent and not yet settled, kept apart from state so a second click in the same tick finds them. */
  const inFlight = useRef(new Set<string>());
  const setState = useCallback((keys: readonly string[], state: 'sending' | 'sent' | null) => {
    setAnswering((current) => {
      const next = new Map(current);
      for (const key of keys) {
        if (state === null) next.delete(key);
        else next.set(key, state);
      }
      return next;
    });
  }, []);

  const answer = useCallback(
    async (answers: Answer[], verb: 'approve' | 'reject') => {
      const fresh = answers.filter((a) => !inFlight.current.has(a.key));
      if (fresh.length === 0) return;
      for (const a of fresh) inFlight.current.add(a.key);
      setState(
        fresh.map((a) => a.key),
        'sending'
      );
      for (let i = 0; i < fresh.length; i++) {
        const a = fresh[i]!;
        let went = false;
        try {
          went = await resolveRef.current(a.runId, a.requestId, a.optionId);
        } catch {
          went = false;
        }
        if (!went) {
          // This one and the ones not sent yet come back.
          const back = fresh.slice(i);
          for (const b of back) inFlight.current.delete(b.key);
          setState(
            back.map((b) => b.key),
            null
          );
          failureToast(verb, fresh, i);
          return;
        }
        inFlight.current.delete(a.key);
        setState([a.key], 'sent');
      }
    },
    [setState]
  );

  const forYouRef = useRef(forYou);
  forYouRef.current = forYou;
  const answerOf = useCallback(
    (runId: string, requestId: string, pick: typeof approveOption): Answer | null => {
      const request = forYouRef.current.approvals
        .find((a) => a.runId === runId)
        ?.pending.find((p) => p.requestId === requestId);
      const option = request ? pick(request.options) : undefined;
      return option
        ? { runId, requestId, key: requestKey(runId, requestId), optionId: option.optionId }
        : null;
    },
    []
  );
  const approve = useCallback(
    async (runId: string, requestId: string) => {
      const a = answerOf(runId, requestId, approveOption);
      if (a) await answer([a], 'approve');
    },
    [answer, answerOf]
  );
  const reject = useCallback(
    async (runId: string, requestId: string) => {
      const a = answerOf(runId, requestId, rejectOption);
      if (a) await answer([a], 'reject');
    },
    [answer, answerOf]
  );
  const approveAll = useCallback(
    async (runId: string) => {
      const approval = forYouRef.current.approvals.find((a) => a.runId === runId);
      const answers = (approval?.pending ?? []).flatMap(
        (p) => answerOf(runId, p.requestId, approveOption) ?? []
      );
      await answer(answers, 'approve');
    },
    [answer, answerOf]
  );

  return { forYou, ready, arrivals, dismiss, approve, approveAll, reject };
}
