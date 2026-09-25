import { ChevronRight, Plug } from 'lucide-react';
import { useState } from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { connectorById, type ConnectorId, type ConnectResult, type GlobalServer } from '@shared/spaces/connectors';
import { connectorsApi } from '../connectors-api';
import { displayServerName, groupGlobalSetup, viaGlobalSetupLabel } from '../global-setup';
import { AGENT_NAME } from './identity';
import { ConnectorLogo, ConnectorMark } from '../logos';
import { readPanelSectionExpanded, writePanelSectionExpanded } from '../panel-section-storage';
import type { RelayRoomSource } from '../relay-room-source';
import type { RoomConnector, RoomSnapshot } from '../types';

/**
 * Spaces: the Connectors section of the space panel (connectors-spec.md's
 * "Renderer") — the tools this space uses, each person's own connect state,
 * and (for owners/editors) adding or removing one. No modals or menus, per
 * house style: "+ Add" opens the tool gallery beside the panel
 * (`ConnectorGallery`), and each row's own consent line and waiting state
 * live right under it.
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

function subLabel(mine: RoomConnector['mine'], addedByName: string, isMine: boolean, viaLabel: string | null): string {
  if (mine === 'connected') return 'Connected as you';
  // A tool one of your agents already reaches globally: say that instead of
  // nagging about the rig connection — the product rule is "don't nudge you
  // to connect a tool your agent already has that way".
  if (viaLabel) return viaLabel;
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
  globalSetup,
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
  /** Your agents' own global MCP setup, so a tool one of them already reaches this way reads "Via your Claude setup" instead of nagging you to connect it. */
  globalSetup: readonly GlobalServer[];
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
  const viaLabel = connected ? null : viaGlobalSetupLabel(connector.id, globalSetup);
  const phase = pending?.phase ?? null;

  return (
    <>
      <div
        className="group/row hover:bg-bg-2 relative flex min-h-8 items-center gap-2 rounded-control px-2 py-1 transition-colors"
        data-testid="connector-row"
        data-connector={connector.id}
        data-state={phase ?? mine}
      >
        {def ? (
          <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={18} />
        ) : (
          <span className="bg-bg-3 size-[18px] shrink-0 rounded" />
        )}
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <b className="truncate text-xs font-medium text-text-primary">{connector.name}</b>
          <span
            className={cn(
              'flex min-w-0 items-center gap-1 truncate text-2xs whitespace-nowrap',
              connected ? 'text-text-secondary' : viaLabel ? 'text-text-muted' : expired ? 'text-warning' : 'text-text-muted'
            )}
          >
            {(connected || expired || viaLabel) && (
              <span
                className={cn('size-1.5 rounded-full', connected ? 'bg-success' : viaLabel ? 'bg-text-muted' : 'bg-warning')}
              />
            )}
            {phase === 'waiting' ? 'Waiting for your browser…' : subLabel(mine, addedByName, isMine, viaLabel)}
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
                  // Still available (the other agent may not have it) — just
                  // quieter, since your agent can already reach this one.
                  viaLabel
                    ? 'text-text-muted hover:text-text-primary'
                    : expired
                      ? 'bg-warning/15 text-warning hover:bg-warning/25'
                      : 'bg-accent-subtle text-accent hover:bg-accent/25'
                )}
              >
                {expired ? 'Reconnect' : 'Connect'}
              </button>
            )
          ) : (
            // Out of the layout (so the name never squeezes), over the row's
            // right end on hover, on the row's own hover fill.
            <span className="bg-bg-2 pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 rounded-control pl-2 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
              <button
                type="button"
                onClick={() => void onDisconnect()}
                title="Forget your own login on this computer"
                className="hover:bg-bg-3 h-6 rounded-full px-2 text-2xs text-text-muted transition-colors hover:text-text-primary"
              >
                Disconnect
              </button>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => (armedRemove ? void onRemove() : onArmRemove())}
                  title="Remove it from this space, for everyone"
                  className={cn(
                    'h-6 rounded-full px-2 text-2xs transition-colors',
                    armedRemove ? 'bg-danger/15 text-danger' : 'text-text-muted hover:text-text-primary'
                  )}
                >
                  {armedRemove ? 'Remove for all?' : 'Remove'}
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

/**
 * The quiet, collapsed-by-default line under the connector rows: "Your
 * agents also bring N tools from their own setup" — expands to a compact
 * list grouped by agent, name only, nothing actionable (rig never touches
 * this setup, it only shows it).
 */
function GlobalSetupDisclosure({ servers, bindingId }: { servers: readonly GlobalServer[]; bindingId: string }) {
  const [open, setOpen] = useState(() => readPanelSectionExpanded(bindingId, 'connectors-global-setup') ?? false);
  if (servers.length === 0) return null;
  const groups = groupGlobalSetup(servers);
  const toggle = () => {
    setOpen((current) => {
      const next = !current;
      writePanelSectionExpanded(bindingId, 'connectors-global-setup', next);
      return next;
    });
  };
  return (
    <div className="border-border-hairline mt-1 border-t pt-1" data-testid="global-setup-disclosure">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-1.5 px-2 text-left text-2xs text-text-muted transition-colors hover:text-text-primary"
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} strokeWidth={1.5} />
        Your agents also bring {servers.length} {servers.length === 1 ? 'tool' : 'tools'} from their own setup
      </button>
      {open && (
        <div className="popover-in flex flex-col gap-2 px-2 pb-1.5 pl-6">
          {groups.map((group) => (
            <div key={group.agent} className="flex flex-col gap-1">
              <span className="text-2xs font-medium text-text-muted">{AGENT_NAME[group.agent]}</span>
              {group.servers.map((server, i) => {
                const def = server.connectorId ? connectorById(server.connectorId) : null;
                return (
                  <span
                    key={`${server.agent}-${server.name}-${i}`}
                    className="flex min-w-0 items-center gap-1.5 text-2xs text-text-secondary"
                  >
                    {def ? (
                      <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={14} />
                    ) : (
                      <Plug className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
                    )}
                    <span className="truncate">{displayServerName(server.name)}</span>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConnectorsSection({
  snapshot,
  selfUserId,
  source,
  bindingId,
  onOpenGallery,
  globalSetup = [],
  onExpand,
}: {
  snapshot: RoomSnapshot;
  selfUserId: string;
  /** "+ Add" opens the tool gallery beside the panel (see `ConnectorGallery`). */
  onOpenGallery?: () => void;
  /** Only ever rendered against the live relay — the scripted demo has no accounts/logins to connect. */
  source: RelayRoomSource;
  /** Keys this section's remembered expanded/collapsed state to its space. */
  bindingId: string;
  /** Your agents' own global MCP setup — loaded once per Room by `RoomView`, cheap to refresh on expand (main caches it). */
  globalSetup?: readonly GlobalServer[];
  /** Called the moment this section opens, so `RoomView` can refresh `globalSetup`. */
  onExpand?: () => void;
}) {
  const self = snapshot.members.find((m) => m.id === selfUserId);
  const canWrite = self?.role === 'owner' || self?.role === 'editor';
  const [pending, setPending] = useState<PendingConnect | null>(null);
  const [armedRemoveId, setArmedRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default; remembered per space. A connect flow in progress
  // forces it open regardless (you can't hide the thing you're mid-way
  // through), without disturbing the remembered preference.
  const [expanded, setExpanded] = useState(() => readPanelSectionExpanded(bindingId, 'connectors') ?? false);
  const toggleExpanded = () => {
    setExpanded((current) => {
      const next = !current;
      writePanelSectionExpanded(bindingId, 'connectors', next);
      if (next) onExpand?.();
      return next;
    });
  };
  const visible = expanded || pending !== null;

  const connectors = snapshot.connectors;
  // A connector one of your agents already reaches from its own global setup
  // doesn't need you to do anything — it's left out of the "to connect" count.
  const needsAction = connectors.filter(
    (c) => (c.mine ?? 'not_connected') !== 'connected' && !viaGlobalSetupLabel(c.id, globalSetup)
  );
  const anyExpired = needsAction.some((c) => c.mine === 'expired');

  const startConnect = (id: string, isNew: boolean) => {
    setError(null);
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

  const newRowDef = pending?.isNew && !connectors.some((c) => c.id === pending.id) ? connectorById(pending.id) : null;

  return (
    <div className="flex flex-col" data-testid="connectors-section">
      <div className="border-border-hairline mt-1.5 flex h-8 shrink-0 items-center gap-2 border-t px-2 pt-1.5">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={visible}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
          data-testid="connectors-summary-row"
        >
          <Plug className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
          <span className="text-xs text-text-primary">Connectors</span>
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            {!visible && connectors.length > 0 && (
              <>
                <span className="flex items-center">
                  {connectors.slice(0, 4).map((c, i) => (
                    <ConnectorMark key={c.id} connector={c} size={14} className={cn('ring-bg-1 ring-1', i > 0 && '-ml-1')} />
                  ))}
                </span>
                <span className="font-mono text-2xs text-text-muted">{connectors.length}</span>
              </>
            )}
            {!visible && needsAction.length > 0 && (
              <span className={cn('text-2xs whitespace-nowrap', anyExpired ? 'text-warning' : 'text-text-muted')}>
                {needsAction.length} to connect
              </span>
            )}
            <ChevronRight
              className={cn('size-3 shrink-0 text-text-muted transition-transform', visible && 'rotate-90')}
              strokeWidth={1.5}
            />
          </span>
        </button>
        {canWrite && visible && (
          <button
            type="button"
            onClick={() => {
              setPending(null);
              onOpenGallery?.();
            }}
            className="hover:bg-bg-2 ml-1 shrink-0 rounded-chip px-2 py-0.5 text-2xs text-text-muted transition-colors hover:text-text-primary"
            data-testid="connectors-add-toggle"
          >
            + Add
          </button>
        )}
      </div>

      {visible && (
        <div className="popover-in flex shrink-0 flex-col" data-testid="connectors-expanded">
          {error && (
            <p className="px-2 pb-1 text-2xs text-danger" data-testid="connectors-error">
              {error}
            </p>
          )}

          {connectors.length === 0 && !newRowDef && (
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
              globalSetup={globalSetup}
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
              globalSetup={globalSetup}
              onStart={() => {}}
              onGo={goConnect}
              onCancel={cancelPending}
              onDisconnect={async () => {}}
              onArmRemove={() => {}}
              onRemove={async () => {}}
            />
          )}

          <GlobalSetupDisclosure servers={globalSetup} bindingId={bindingId} />
        </div>
      )}
    </div>
  );
}
