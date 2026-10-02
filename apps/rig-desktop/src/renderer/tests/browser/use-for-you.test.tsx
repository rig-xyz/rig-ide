import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomMessage, RoomSnapshot, SessionEvent } from '@renderer/features/spaces/types';
import { useForYou, type ForYouState } from '@renderer/features/spaces/use-for-you';
import type { RigNotification } from '@shared/rig/notifications';

const resolvePermission = vi.fn(
  async (_input: unknown): Promise<{ resolved: boolean }> => ({ resolved: true })
);
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: { spacesDispatch: { resolvePermission: (input: unknown) => resolvePermission(input) } },
  },
  events: { on: () => () => {} },
}));
const toast = vi.fn();
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: (input: unknown) => toast(input) }));

let activity: RigNotification[] | null = null;
const inboxArgs: unknown[][] = [];
vi.mock('@renderer/features/notifications/use-notifications', () => ({
  useSpaceActivity: (...args: unknown[]) => {
    inboxArgs.push(args);
    return activity;
  },
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const msg = (id: string, seq: number, extra: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  seq,
  authorId: 'maya',
  createdAt: new Date(Date.UTC(2026, 9, 1, 10, seq)).toISOString(),
  time: '10:00',
  body: id,
  meta: { kind: 'text' },
  ...extra,
});

const row = (id: string, messageId: string): RigNotification => ({
  id,
  type: 'mention',
  tier: 'direct',
  bindingId: 'b1',
  spaceName: 'Launch',
  actor: { kind: 'user', userId: 'maya', name: 'Maya', agent: null },
  messageId,
  messageSeq: null,
  runId: null,
  requestId: null,
  inviteId: null,
  path: null,
  title: '',
  body: 'hey',
  createdAt: '2026-10-01T10:00:00Z',
  readAt: null,
});

const permission = (requestId: string, seq: number): SessionEvent[] => [
  {
    seq,
    kind: 'tool_call',
    payload: { toolCallId: `t-${requestId}`, title: 'ls', kind: 'execute', status: 'pending' },
  },
  {
    seq: seq + 1,
    kind: 'permission_requested',
    payload: {
      requestId,
      toolCall: { toolCallId: `t-${requestId}`, title: 'ls' },
      options: [
        { optionId: `reject-${requestId}`, name: 'No', kind: 'reject_once' },
        { optionId: `always-${requestId}`, name: 'Always', kind: 'allow_always' },
        { optionId: `allow-${requestId}`, name: 'Yes', kind: 'allow_once' },
      ],
    },
  },
];

function room(
  messages: RoomMessage[],
  events: SessionEvent[] = [],
  extra: Partial<RoomSnapshot> = {}
): RoomSnapshot {
  return {
    name: 'launch',
    ready: true,
    members: [
      { id: 'me', name: 'Dylan', email: 'd@x.co', role: 'owner', initial: 'D', status: 'here' },
    ],
    agents: [],
    connectors: [],
    skills: [],
    messages,
    invitesById: {},
    sessionMetaByRun: {
      r1: {
        id: 'r1',
        agent: 'claude',
        owner: 'me',
        model: 'x',
        title: '',
        status: 'running',
        startedAt: '2026-10-01T10:00:00Z',
        endedAt: null,
      },
    },
    sessionEventsByRun: { r1: events },
    typingUserIds: [],
    ...extra,
  };
}

describe('useForYou', () => {
  let host: HTMLDivElement;
  let root: Root;
  let latest: ForYouState;
  const arrivalLog: string[][] = [];

  let options: Parameters<typeof useForYou>[3];
  function Probe({ snapshot }: { snapshot: RoomSnapshot }) {
    latest = useForYou('b1', snapshot, 'me', options);
    const keys = latest.arrivals.map((a) => a.key);
    React.useEffect(() => {
      if (keys.length > 0) arrivalLog.push(keys);
    }, [latest.arrivals]); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
  }
  const show = async (snapshot: RoomSnapshot) => {
    await act(async () => root.render(<Probe snapshot={snapshot} />));
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    arrivalLog.length = 0;
    resolvePermission.mockReset();
    resolvePermission.mockImplementation(async () => ({ resolved: true }));
    toast.mockClear();
    inboxArgs.length = 0;
    options = undefined;
    activity = null;
    localStorage.clear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('does not count what is there when the Room opens, but does count what comes after', async () => {
    activity = [row('n1', 'm1')];
    await show(room([msg('m1', 1)], permission('p1', 1)));
    expect(latest.forYou.asks.map((a) => a.messageId)).toEqual(['m1']);
    expect(latest.forYou.approvals).toHaveLength(1);
    expect(arrivalLog).toEqual([]);

    activity = [row('n1', 'm1'), row('n2', 'm2')];
    await show(
      room([msg('m1', 1), msg('m2', 2)], [...permission('p1', 1), ...permission('p2', 3)])
    );
    expect(arrivalLog).toEqual([['ask:m2', 'approval:r1:p2']]);
    // Re-rendering with nothing new keeps the same arrivals array: no second announcement.
    const first = latest.arrivals;
    await show(
      room([msg('m1', 1), msg('m2', 2)], [...permission('p1', 1), ...permission('p2', 3)])
    );
    expect(latest.arrivals).toBe(first);
    expect(arrivalLog).toHaveLength(1);
  });

  it('waits for the inbox and for a Room shown from disk to catch up before it looks', async () => {
    await show(room([msg('m1', 1)], [], { stale: true }));
    activity = [row('n1', 'm1')];
    await show(room([msg('m1', 1)], [], { stale: true }));
    await show(room([msg('m1', 1)]));
    expect(latest.forYou.asks).toHaveLength(1);
    expect(arrivalLog).toEqual([]);
  });

  it('dismisses an ask for good on this computer', async () => {
    activity = [row('n1', 'm1')];
    await show(room([msg('m1', 1)]));
    await act(async () => latest.dismiss('n1'));
    expect(latest.forYou.asks).toEqual([]);
    expect(JSON.parse(localStorage.getItem('rig-for-you-dismissed:b1')!)).toEqual(['n1']);
    await act(async () => root.unmount());
    root = createRoot(host);
    await show(room([msg('m1', 1)]));
    expect(latest.forYou.asks).toEqual([]);
  });

  it("reads this Space's own inbox, unless the rows are given", async () => {
    activity = [];
    await show(room([]));
    expect(inboxArgs.at(-1)).toEqual(['b1', true]);
    options = { notifications: [] };
    await show(room([]));
    expect(inboxArgs.at(-1)).toEqual(['b1', false]);
  });

  describe('answering a request', () => {
    const pendingIds = () =>
      latest.forYou.approvals.flatMap((a) => a.pending.map((p) => p.requestId));
    const answered = () => resolvePermission.mock.calls.map((c) => c[0]);
    /** A call that settles when the test says so. */
    const hold = () => {
      const settle: Array<(value: { resolved: boolean } | Error) => void> = [];
      resolvePermission.mockImplementation(
        () =>
          new Promise((resolve, reject) =>
            settle.push((value) => (value instanceof Error ? reject(value) : resolve(value)))
          )
      );
      return settle;
    };

    it('approves with the one-off allow and rejects with the deny, one request each', async () => {
      activity = [];
      await show(room([], [...permission('p1', 1), ...permission('p2', 3)]));
      await act(async () => {
        await latest.approve('r1', 'p2');
        await latest.reject('r1', 'p1');
      });
      expect(answered()).toEqual([
        { runId: 'r1', requestId: 'p2', optionId: 'allow-p2' },
        { runId: 'r1', requestId: 'p1', optionId: 'reject-p1' },
      ]);
      expect(toast).not.toHaveBeenCalled();
    });

    it('approves every request of a run in order, and does nothing for one that is not there', async () => {
      activity = [];
      await show(room([], [...permission('p1', 1), ...permission('p2', 3)]));
      await act(async () => {
        await latest.approveAll('r1');
        await latest.approve('r1', 'nope');
        await latest.approve('gone', 'p1');
      });
      expect(answered()).toEqual([
        { runId: 'r1', requestId: 'p1', optionId: 'allow-p1' },
        { runId: 'r1', requestId: 'p2', optionId: 'allow-p2' },
      ]);
    });

    it('takes the request out at once, and keeps it out once answered until the snapshot drops it', async () => {
      activity = [];
      const settle = hold();
      const events = [...permission('p1', 1), ...permission('p2', 3)];
      await show(room([], events));
      expect(pendingIds()).toEqual(['p1', 'p2']);
      let done!: Promise<void>;
      await act(async () => {
        done = latest.approve('r1', 'p1');
      });
      // Still on its way: already out of the model, and the other stays.
      expect(pendingIds()).toEqual(['p2']);
      expect(latest.forYou.messageIds.size).toBe(0);
      await act(async () => {
        settle[0]!({ resolved: true });
        await done;
      });
      // The relay has the answer but the snapshot still lists the request: it does not come back.
      expect(pendingIds()).toEqual(['p2']);
      await show(room([], events.slice(2)));
      expect(pendingIds()).toEqual(['p2']);
      // A run left with nothing pending goes with its request.
      await act(async () => {
        void latest.reject('r1', 'p2');
      });
      expect(latest.forYou.approvals).toEqual([]);
    });

    it('sends a double click once', async () => {
      activity = [];
      const settle = hold();
      await show(room([], permission('p1', 1)));
      await act(async () => {
        void latest.approve('r1', 'p1');
        void latest.approve('r1', 'p1');
        void latest.reject('r1', 'p1');
      });
      await act(async () => {
        void latest.approve('r1', 'p1');
      });
      expect(answered()).toHaveLength(1);
      await act(async () => settle[0]!({ resolved: true }));
      expect(answered()).toHaveLength(1);
    });

    it('brings the request back and says so when the call throws', async () => {
      activity = [];
      resolvePermission.mockRejectedValue(new Error('offline'));
      await show(room([], permission('p1', 1)));
      await act(async () => {
        await latest.approve('r1', 'p1');
      });
      expect(pendingIds()).toEqual(['p1']);
      expect(toast).toHaveBeenCalledOnce();
      expect(toast.mock.calls[0]![0]).toMatchObject({ title: 'Couldn’t approve that request' });
      // And it can be answered again.
      resolvePermission.mockResolvedValue({ resolved: true });
      await act(async () => {
        await latest.approve('r1', 'p1');
      });
      expect(pendingIds()).toEqual([]);
    });

    it('brings the request back and says so when the run did not take the answer', async () => {
      activity = [];
      resolvePermission.mockResolvedValue({ resolved: false });
      await show(room([], permission('p1', 1)));
      await act(async () => {
        await latest.reject('r1', 'p1');
      });
      expect(pendingIds()).toEqual(['p1']);
      expect(toast.mock.calls[0]![0]).toMatchObject({ title: 'Couldn’t reject that request' });
    });

    it('approves all in order and stops at the first that fails, keeping the ones not sent', async () => {
      activity = [];
      resolvePermission
        .mockResolvedValueOnce({ resolved: true })
        .mockResolvedValueOnce({ resolved: false });
      await show(
        room([], [...permission('p1', 1), ...permission('p2', 3), ...permission('p3', 5)])
      );
      await act(async () => {
        await latest.approveAll('r1');
      });
      expect(answered().map((a) => (a as { requestId: string }).requestId)).toEqual(['p1', 'p2']);
      expect(pendingIds()).toEqual(['p2', 'p3']);
      expect(toast.mock.calls[0]![0]).toMatchObject({
        title: 'Couldn’t approve all of them',
        description: '1 request approved before it stopped. 2 requests still waiting in the list.',
      });
    });

    it('answers through the given function instead of the real call (the scripted demo)', async () => {
      activity = [];
      const local = vi.fn(async () => true);
      options = { resolvePermission: local };
      await show(room([], permission('p1', 1)));
      await act(async () => {
        await latest.approve('r1', 'p1');
      });
      expect(local).toHaveBeenCalledWith('r1', 'p1', 'allow-p1');
      expect(resolvePermission).not.toHaveBeenCalled();
      expect(pendingIds()).toEqual([]);
    });
  });
});
