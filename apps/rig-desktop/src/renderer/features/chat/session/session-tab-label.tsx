import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { BrandLogo } from '@renderer/features/spaces/logos';
import { rpc } from '@renderer/lib/ipc';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { ReplayStore } from '../replay-store';
import { RigChatStore } from '../rig-chat-store';
import { rigSessionRegistry } from './rig-session-registry';

/**
 * A space session's tab beside the Room: Claude's mark, its title, and what
 * it's doing (the dock's dot matrix while it works, amber while it waits on
 * you). The title comes from the session's store when one is held here,
 * else from its stored row.
 */
export const SessionTabLabel = observer(function SessionTabLabel({ sessionId }: { sessionId: string }) {
  const held = rigSessionRegistry.get(sessionId);
  const live = held instanceof RigChatStore && !held.disposed ? held : null;
  const replay = held instanceof ReplayStore ? held : null;
  const { data: stored } = useQuery({
    queryKey: ['rig', 'sessions', 'get', sessionId],
    queryFn: () => rpc.rig.sessions.getSession({ sessionId }),
    enabled: !live?.title && !replay?.session?.title,
    staleTime: 30_000,
  });
  const title = live?.title ?? replay?.session?.title ?? stored?.title ?? 'Session';
  const waiting = !!live && live.permissionQueue.length > 0;
  const working = !!live && !waiting && live.affordances.isWorking;
  return (
    <>
      <BrandLogo id="claude" size={12} />
      <span className="max-w-40 truncate">{title}</span>
      {(waiting || working) && (
        <DotMatrix
          state={waiting ? 'waiting' : 'thinking'}
          size="sm"
          tone={waiting ? 'warn' : 'accent'}
          label={waiting ? 'Waiting on you' : 'Working'}
        />
      )}
    </>
  );
});
