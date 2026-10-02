import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { connectorById } from '@shared/spaces/connectors';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import { agentLabel, deriveSpaceAttention } from './space-status-state';
import { SpaceStatusTile } from './space-status-tile';
import { ConnectorLogo } from '@renderer/features/spaces/logos';
import type { HomeRigRow } from './home-sections';

// How many spaces we'll ask "do you use this connector" for, per expired
// connector — the whole point of this card is naming the spaces it's used
// in, so this can't be zero, but it also shouldn't fan out to every space
// this account has ever touched.
const MAX_SPACES_CHECKED = 24;

/**
 * "Needs you" (design doc "9a"): what's cheaply, honestly known to be
 * waiting on this person specifically —
 *
 *  1. An agent request YOU started that's sitting on a pending approval —
 *     read straight off `rpc.rig.spaceStatus.get()`'s own `running[]`
 *     (`activity === 'waiting'` + `ownerUserId === you`), no extra call.
 *  2. A connector login that's expired (`rpc.rig.connectors.list()`,
 *     state `'expired'`) — named to the spaces that actually use it
 *     (`rpc.rig.spacesConnection.listConnectors`, one small query per
 *     candidate space).
 *
 * Deliberately NOT here (design doc's own "keep it to what's cheaply
 * available"): agent requests waiting on a teammate's own device (this
 * app's main process only knows about ITS OWN dispatched agents' held
 * permissions, and that isn't exposed over any existing RPC this round
 * owns — see the shipped report for the omission).
 */
export function NeedsYouSection({
  spaceRows,
  statusByBinding,
  selfUserId,
  onOpenPath,
}: {
  spaceRows: readonly HomeRigRow[];
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  selfUserId: string | null;
  onOpenPath: (path: string) => void;
}) {
  const approvals = selfUserId ? approvalCards(spaceRows, statusByBinding, selfUserId) : [];
  const expired = useExpiredConnectorCards(spaceRows);

  const cards = [...approvals, ...expired];
  if (cards.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" data-testid="needs-you">
      <h2 className="text-text-primary text-sm font-medium">
        Needs you <span className="text-text-muted font-normal">· {cards.length}</span>
      </h2>
      <div className="flex flex-col gap-2">
        {cards.map((card) =>
          card.kind === 'approval' ? (
            <ApprovalCard key={card.bindingId} card={card} status={statusByBinding.get(card.bindingId)} onOpenPath={onOpenPath} />
          ) : (
            <ExpiredConnectorCard key={card.connectorId} card={card} />
          )
        )}
      </div>
    </section>
  );
}

type ApprovalCardData = {
  kind: 'approval';
  bindingId: string;
  name: string;
  path: string | null;
  agent: string;
  title: string | null;
};

function approvalCards(
  rows: readonly HomeRigRow[],
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>,
  selfUserId: string
): ApprovalCardData[] {
  const out: ApprovalCardData[] = [];
  for (const row of rows) {
    const status = statusByBinding.get(row.bindingId);
    const waiting = status?.running.find((r) => r.activity === 'waiting' && r.ownerUserId === selfUserId);
    if (!waiting) continue;
    out.push({
      kind: 'approval',
      bindingId: row.bindingId,
      name: row.name ?? row.bindingId,
      path: row.kind === 'local' ? row.path : null,
      agent: agentLabel(waiting.agent),
      title: waiting.title ?? null,
    });
  }
  return out;
}

function ApprovalCard({
  card,
  status,
  onOpenPath,
}: {
  card: ApprovalCardData;
  status: RigSpaceStatus | undefined;
  onOpenPath: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => card.path && onOpenPath(card.path)}
      disabled={!card.path}
      className="border-border-hairline bg-bg-1 hover:bg-bg-2 flex items-center gap-3 rounded-card border p-3 text-left transition-colors disabled:cursor-default"
    >
      {/* A card here is always a waiting run, so the tile is always live — no read marker needed. */}
      <SpaceStatusTile attention={deriveSpaceAttention(status, null, null)} seed={card.bindingId} />
      <div className="min-w-0 flex-1">
        <p className="text-text-primary text-sm">
          {card.agent} wants{card.title ? <> to <span className="font-medium">{card.title.replace(/^./, (c) => c.toLowerCase())}</span></> : ' your approval'}
        </p>
        <p className="text-text-muted font-mono text-xs">
          # {card.name} · waiting
        </p>
      </div>
      <span className="bg-accent-subtle text-accent shrink-0 rounded-chip px-2 py-1 text-xs">Review</span>
    </button>
  );
}

type ExpiredConnectorCardData = {
  kind: 'expired';
  connectorId: string;
  name: string;
  brand: string;
  spaceNames: string[];
};

function useExpiredConnectorCards(spaceRows: readonly HomeRigRow[]): ExpiredConnectorCardData[] {
  const connectorsQuery = useQuery({
    queryKey: ['rig', 'connectors', 'list'],
    queryFn: () => rpc.rig.connectors.list(),
    staleTime: 60_000,
  });
  const expiredIds = (connectorsQuery.data ?? []).filter((c) => c.state === 'expired').map((c) => c.id);

  const candidates = spaceRows.slice(0, MAX_SPACES_CHECKED);
  const listings = useQueries({
    queries: candidates.map((row) => ({
      queryKey: ['rig', 'spacesConnection', 'listConnectors', row.bindingId],
      queryFn: () => rpc.rig.spacesConnection.listConnectors({ bindingId: row.bindingId }),
      staleTime: 60_000,
      enabled: expiredIds.length > 0,
    })),
  });

  if (expiredIds.length === 0) return [];

  return expiredIds.flatMap((id): ExpiredConnectorCardData[] => {
    const def = connectorById(id);
    if (!def) return [];
    const spaceNames = candidates
      .filter((row, i) => {
        const result = listings[i]?.data;
        return result?.success && result.data.some((c) => c.connectorId === id);
      })
      .map((row) => row.name ?? row.bindingId);
    if (spaceNames.length === 0) return [];
    return [{ kind: 'expired', connectorId: id, name: def.name, brand: def.brand, spaceNames }];
  });
}

function ExpiredConnectorCard({ card }: { card: ExpiredConnectorCardData }) {
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const usedIn = card.spaceNames.map((n) => `#${n}`);
  const usedInText =
    usedIn.length === 1 ? usedIn[0] : usedIn.length === 2 ? `${usedIn[0]} and ${usedIn[1]}` : `${usedIn.length} spaces`;

  const reconnect = async () => {
    setConnecting(true);
    try {
      await rpc.rig.connectors.connect({ id: card.connectorId });
    } finally {
      setConnecting(false);
      void queryClient.invalidateQueries({ queryKey: ['rig', 'connectors', 'list'] });
    }
  };

  return (
    <div className="border-border-hairline bg-bg-1 flex items-center gap-3 rounded-card border p-3">
      <ConnectorLogo id={card.connectorId} name={card.name} brand={card.brand} size={28} />
      <div className="min-w-0 flex-1">
        <p className="text-text-primary text-sm">Your {card.name} login expired</p>
        <p className="text-text-muted text-xs">Used in {usedInText}</p>
      </div>
      <button
        type="button"
        onClick={() => void reconnect()}
        disabled={connecting}
        className="bg-warning/15 text-warning flex shrink-0 items-center gap-1 rounded-chip px-2 py-1 text-xs transition-opacity disabled:opacity-60"
      >
        <AlertTriangle className="size-3 shrink-0" strokeWidth={1.5} />
        {connecting ? 'Connecting…' : 'Reconnect'}
      </button>
    </div>
  );
}
