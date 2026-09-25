import { Plug } from 'lucide-react';
import { useState } from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { CONNECTORS, connectorById, type ConnectorId, type ConnectResult } from '@shared/spaces/connectors';
import { connectorsApi } from '../connectors-api';
import { ConnectorTile } from '../logos';
import type { RelayRoomSource } from '../relay-room-source';
import type { RoomConnector, RoomSnapshot } from '../types';

/**
 * Spaces: the Connectors section of the space panel (connectors-spec.md's
 * "Renderer") — the tools this space uses, each person's own connect state,
 * and (for owners/editors) adding or removing one. No modals or menus, per
 * house style: the catalog opens in place, and each row's own consent line
 * and waiting state live right under it.
 */

/** A connect (or reconnect) in flight for one connector: the consent line, then waiting for the browser. */
type PendingConnect = { id: string; phase: 'consent' | 'waiting'; isNew: boolean };

/**
 * A standalone "Connect"/"Reconnect" pill for contexts outside the panel
 * (the transcript's `ConnectorCard`, an agent turn's footer gap pill) — its
 * own tiny idle/waiting state, no inline consent line (the panel is where
 * that lives; these pills just start the same browser round trip).
 */
export function ConnectPill({
  label,
  variant = 'accent',
  onConnect,
  onCancel,
}: {
  label: string;
  variant?: 'accent' | 'warn';
  onConnect: () => Promise<ConnectResult>;
  onCancel?: () => Promise<void>;
}) {
  const [waiting, setWaiting] = useState(false);
  if (waiting) {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs text-text-muted" data-testid="connect-pill-waiting">
        <DotMatrix state="waiting" size="sm" />
        Waiting for your browser…
        <button
          type="button"
          onClick={() => {
            setWaiting(false);
            void onCancel?.();
          }}
          className="hover:text-text-primary"
        >
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setWaiting(true);
        void onConnect().finally(() => setWaiting(false));
      }}
      className={cn(
        'h-6 shrink-0 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors',
        variant === 'warn' ? 'bg-warning/15 text-warning hover:bg-warning/25' : 'bg-accent-subtle text-accent hover:bg-accent/25'
      )}
    >
      {label}
    </button>
  );
}

function subLabel(mine: RoomConnector['mine'], addedByName: string, isMine: boolean): string {
  if (mine === 'connected') return 'Connected as you';
  if (mine === 'expired') return 'Login expired';
  return isMine ? 'Not connected yet' : `Added by ${addedByName} · not connected`;
}

function ConnectorRow({
  connector,
  addedByName,
  isMine,
  canWrite,
  pending,
  armedRemove,
  onStart,
  onGo,
  onCancel,
  onDisconnect,
  onArmRemove,
  onRemove,
}: {
  connector: RoomConnector;
  addedByName: string;
  /** This connector was added by the viewer themselves. */
  isMine: boolean;
  canWrite: boolean;
  pending: PendingConnect | null;
  armedRemove: boolean;
  onStart: () => void;
  onGo: () => void;
  onCancel: () => void;
  onDisconnect: () => Promise<void>;
  onArmRemove: () => void;
  onRemove: () => Promise<void>;
}) {
  const def = connectorById(connector.id);
  const mine = connector.mine ?? 'not_connected';
  const connected = mine === 'connected';
  const expired = mine === 'expired';
  const phase = pending?.phase ?? null;

  return (
    <>
      <div
        className="group/row flex min-h-8 items-center gap-2 rounded-control px-2 py-1"
        data-testid="connector-row"
        data-connector={connector.id}
        data-state={phase ?? mine}
      >
        {def ? (
          <ConnectorTile name={def.name} brand={def.brand} size={18} />
        ) : (
          <span className="bg-bg-3 size-[18px] shrink-0 rounded" />
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          <b className="truncate text-xs font-medium text-text-primary">{connector.name}</b>
          <span
            className={cn(
              'flex items-center gap-1 text-2xs',
              connected ? 'text-text-secondary' : expired ? 'text-warning' : 'text-text-muted'
            )}
          >
            {(connected || expired) && (
              <span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-warning')} />
            )}
            {phase === 'waiting' ? 'Waiting for your browser…' : subLabel(mine, addedByName, isMine)}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {phase === 'waiting' ? (
            <>
              <DotMatrix state="waiting" size="sm" />
              <button type="button" onClick={onCancel} className="text-2xs text-text-muted hover:text-text-primary">
                Cancel
              </button>
            </>
          ) : !connected ? (
            phase !== 'consent' && (
              <button
                type="button"
                onClick={onStart}
                className={cn(
                  'h-6 rounded-full px-2.5 text-xs transition-colors',
                  expired ? 'bg-warning/15 text-warning hover:bg-warning/25' : 'bg-accent-subtle text-accent hover:bg-accent/25'
                )}
              >
                {expired ? 'Reconnect' : 'Connect'}
              </button>
            )
          ) : (
            <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                onClick={() => void onDisconnect()}
                className="hover:bg-bg-2 h-6 rounded-full px-2 text-2xs text-text-muted transition-colors hover:text-text-primary"
              >
                Disconnect mine
              </button>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => (armedRemove ? void onRemove() : onArmRemove())}
                  className={cn(
                    'h-6 rounded-full px-2 text-2xs transition-colors',
                    armedRemove ? 'bg-danger/15 text-danger' : 'text-text-muted hover:text-text-primary'
                  )}
                >
                  {armedRemove ? 'Confirm remove?' : 'Remove from space'}
                </button>
              )}
            </span>
          )}
        </span>
      </div>
      {phase === 'consent' && (
        <div
          className="border-border-hairline bg-bg-2 mx-2 mb-1 ml-8 flex flex-col gap-2 rounded-card border p-2.5 text-2xs text-text-secondary"
          data-testid="connector-consent"
        >
          <span>
            Results your agent gets from <b className="font-medium text-text-primary">{connector.name}</b> will show up
            in this Room. You&rsquo;ll sign in to {connector.name} in your browser.
          </span>
          <span className="flex gap-1.5">
            <button
              type="button"
              onClick={onGo}
              className="bg-accent-subtle text-accent hover:bg-accent/25 h-6 rounded-full px-2.5 text-xs transition-colors"
            >
              Continue in browser
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="h-6 rounded-full px-2.5 text-xs text-text-muted hover:text-text-primary"
            >
              Cancel
            </button>
          </span>
        </div>
      )}
    </>
  );
}

export function ConnectorsSection({
  snapshot,
  selfUserId,
  source,
}: {
  snapshot: RoomSnapshot;
  selfUserId: string;
  /** Only ever rendered against the live relay — the scripted demo has no accounts/logins to connect. */
  source: RelayRoomSource;
}) {
  const self = snapshot.members.find((m) => m.id === selfUserId);
  const canWrite = self?.role === 'owner' || self?.role === 'editor';
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [pending, setPending] = useState<PendingConnect | null>(null);
  const [armedRemoveId, setArmedRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectors = snapshot.connectors;
  const catalog = CONNECTORS.filter((c) => !connectors.some((rc) => rc.id === c.id));

  const startConnect = (id: string, isNew: boolean) => {
    setError(null);
    setCatalogOpen(false);
    setPending({ id, phase: 'consent', isNew });
  };

  const cancelPending = () => {
    const wasWaiting = pending?.phase === 'waiting';
    const id = pending?.id;
    setPending(null);
    if (wasWaiting && id) void connectorsApi.cancel(id as ConnectorId);
  };

  const goConnect = () => {
    if (!pending) return;
    const { id, isNew } = pending;
    setPending({ id, phase: 'waiting', isNew });
    void connectorsApi
      .connect(id as ConnectorId)
      .then(async (result) => {
        setPending(null);
        if (!result.ok) {
          if (result.reason !== 'cancelled') setError(result.message ?? `Couldn't connect to ${connectorById(id)?.name ?? id}.`);
          return;
        }
        if (isNew) {
          const added = await source.addConnector(id);
          if (!added.ok) setError(added.message ?? "Couldn't add this to the space.");
        } else {
          await source.refreshConnections();
        }
      });
  };

  const pickCatalog = (id: ConnectorId) => {
    setCatalogOpen(false);
    void connectorsApi.list().then(async (statuses) => {
      const alreadyConnected = statuses.find((s) => s.id === id)?.state === 'connected';
      if (alreadyConnected) {
        const added = await source.addConnector(id);
        if (!added.ok) setError(added.message ?? "Couldn't add this to the space.");
        return;
      }
      startConnect(id, true);
    });
  };

  const newRowDef = pending?.isNew && !connectors.some((c) => c.id === pending.id) ? connectorById(pending.id) : null;

  return (
    <div className="flex flex-col" data-testid="connectors-section">
      <div className="border-border-hairline mt-1.5 flex h-8 shrink-0 items-center gap-2 border-t px-2 pt-1.5">
        <Plug className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
        <span className="text-xs text-text-primary">Connectors</span>
        {canWrite && (
          <button
            type="button"
            onClick={() => {
              setCatalogOpen((v) => !v);
              setPending(null);
            }}
            className="hover:bg-bg-2 ml-auto rounded-chip px-2 py-0.5 text-2xs text-text-muted transition-colors hover:text-text-primary"
            data-testid="connectors-add-toggle"
          >
            {catalogOpen ? 'Done' : '+ Add'}
          </button>
        )}
      </div>

      {error && (
        <p className="px-2 pb-1 text-2xs text-danger" data-testid="connectors-error">
          {error}
        </p>
      )}

      {connectors.length === 0 && !catalogOpen && !newRowDef && (
        <p className="px-2 pb-1.5 text-2xs text-text-muted" data-testid="connectors-empty">
          None yet. Add a tool your team uses; each person&rsquo;s agent reaches it with their own login.
        </p>
      )}

      {connectors.map((c) => (
        <ConnectorRow
          key={c.id}
          connector={c}
          addedByName={snapshot.members.find((m) => m.id === c.addedBy)?.name ?? c.addedBy}
          isMine={c.addedBy === selfUserId}
          canWrite={canWrite}
          pending={pending?.id === c.id ? pending : null}
          armedRemove={armedRemoveId === c.id}
          onStart={() => startConnect(c.id, false)}
          onGo={goConnect}
          onCancel={cancelPending}
          onDisconnect={async () => {
            await connectorsApi.disconnect(c.id as ConnectorId);
            await source.refreshConnections();
          }}
          onArmRemove={() => setArmedRemoveId(c.id)}
          onRemove={async () => {
            setArmedRemoveId(null);
            const result = await source.removeConnector(c.id);
            if (!result.ok) setError(result.message ?? "Couldn't remove this from the space.");
          }}
        />
      ))}

      {newRowDef && pending && (
        <ConnectorRow
          connector={{ id: newRowDef.id, name: newRowDef.name, addedBy: selfUserId }}
          addedByName={self?.name ?? selfUserId}
          isMine
          canWrite={canWrite}
          pending={pending}
          armedRemove={false}
          onStart={() => {}}
          onGo={goConnect}
          onCancel={cancelPending}
          onDisconnect={async () => {}}
          onArmRemove={() => {}}
          onRemove={async () => {}}
        />
      )}

      {catalogOpen && (
        <div className="flex flex-col pb-1" data-testid="connectors-catalog">
          {catalog.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickCatalog(c.id)}
              className="group/cat hover:bg-bg-2 flex h-8 items-center gap-2 rounded-control px-2 text-left transition-colors"
              data-testid="connector-catalog-row"
            >
              <ConnectorTile name={c.name} brand={c.brand} size={16} />
              <span className="flex min-w-0 flex-col leading-tight">
                <b className="truncate text-2xs font-medium text-text-primary">{c.name}</b>
                <span className="truncate text-2xs text-text-muted">{c.blurb}</span>
              </span>
              <span className="text-accent ml-auto text-2xs opacity-0 transition-opacity group-hover/cat:opacity-100">
                Add
              </span>
            </button>
          ))}
          {catalog.length === 0 && <p className="px-2 py-1 text-2xs text-text-muted">Every catalog tool is already in this space.</p>}
        </div>
      )}
    </div>
  );
}
