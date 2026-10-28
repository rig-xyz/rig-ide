import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { ActionButton } from './action-button';

/**
 * The empty Feed. For someone Rig has never read for (they left the first
 * run with Not now), it offers Catch me up: Rig reads nothing on its own
 * until they've had one. Asked, the catch-up strip above shows it reading.
 */

export const SINCE_KEY = ['rig', 'orch', 'since'] as const;

export function FeedEmpty({ live }: { live: boolean }) {
  const [asked, setAsked] = useState(false);
  const { data } = useQuery({
    queryKey: SINCE_KEY,
    queryFn: () => rpc.rig.orch.since(),
    enabled: live,
    // While a Catch me up reads, until its first note says Rig has read for them.
    refetchInterval: asked ? 15_000 : false,
  });
  const never = live && data?.success === true && data.data.since === null;
  if (!never) return <p className="px-5 py-2.5 text-sm text-text-muted">Nothing waiting on you.</p>;
  if (asked) return null;

  const catchUp = async () => {
    setAsked(true);
    const r = await rpc.rig.orch.catchUpNow().catch(() => null);
    // Not started (another run going, or it couldn't ask): the offer comes back.
    if (!r?.success || r.data.outcome !== 'started') setAsked(false);
  };

  return (
    <div className="mx-4 my-2 flex flex-col gap-2 rounded-xl bg-bg-2 px-4 py-3.5" data-testid="feed-catch-me-up">
      <p className="m-0 text-[13px] font-medium text-text-primary">Rig hasn’t read your tools yet.</p>
      <p className="m-0 text-[12.5px] leading-snug text-text-muted">
        Catch me up reads the last 3 days of your tools and puts what needs you here. It only reads, and
        until you ask, Rig reads nothing on its own.
      </p>
      <div>
        <ActionButton icon={RefreshCw} variant="primary" size="sm" onClick={() => void catchUp()}>
          Catch me up
        </ActionButton>
      </div>
    </div>
  );
}
