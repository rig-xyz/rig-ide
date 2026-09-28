import { ChevronRight, Loader2, Plug } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@renderer/lib/utils';
import { connectorById, type ConnectionState, type ConnectorId, type ConnectResult, type GlobalServer } from '@shared/spaces/connectors';
import { globalAgentsFor, viaGlobalSetupLabel, viaGlobalSetupShortLabel } from '../global-setup';
import { ConnectorLogo, ConnectorMark } from '../logos';
import { readPanelSectionExpanded, writePanelSectionExpanded } from '../panel-section-storage';
import type { AgentKind, RoomConnector, RoomSnapshot } from '../types';

/**
 * Spaces: the Connectors section of the space panel (connectors-spec.md's
 * "Renderer") — one line per connector this space uses, a compact status,
 * and the collapsed line for the agents' own global setup. No hover pills,
 * no inline consent box: a row's only job is to open the connector gallery
 * (`ConnectorGallery`) straight on that connector's detail view, where the
 * actual connect/disconnect/remove flow lives.
 */

/** A connect (or reconnect) in flight for one connector: the consent line, then waiting for the browser. Shared by `ConnectPill` below and the gallery's own detail view. */
export type PendingConnect = { id: string; phase: 'consent' | 'waiting'; isNew: boolean };

/**
 * A standalone "Connect"/"Reconnect" pill for contexts outside the panel
 * (the transcript's `ConnectorCard`, an agent turn's footer gap pill) — its
 * own tiny idle/waiting state, no inline consent line (the gallery's detail
 * view is where that lives now); these pills just start the same browser
 * round trip.
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
        <Loader2 className="size-3 animate-spin text-text-muted" strokeWidth={2} />
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

/**
 * The compact right-hand status for a connector, shared by the panel row
 * and the gallery's grid card: connected reads "Connected" behind a green
 * dot; otherwise it's the call to action itself ("Connect"/"Reconnect"),
 * or, when one of your agents already reaches it from its own setup and
 * you haven't connected it via rig, a quiet "Via Claude"-style note.
 */
export function compactConnectorStatus(
  mine: ConnectionState,
  viaLabel: string | null
): { text: string; tone: 'success' | 'warn' | 'muted' | 'accent' } {
  if (mine === 'connected') return { text: 'Connected', tone: 'success' };
  if (mine === 'expired') return { text: 'Reconnect', tone: 'warn' };
  if (viaLabel) return { text: viaLabel, tone: 'muted' };
  return { text: 'Connect', tone: 'accent' };
}

const STATUS_TEXT_CLASS: Record<ReturnType<typeof compactConnectorStatus>['tone'], string> = {
  success: 'text-text-secondary',
  warn: 'text-warning',
  muted: 'text-text-muted',
  accent: 'text-accent',
};

/**
 * The one full sentence for a connector's own connection state — "Connected
 * as dtsbourg@gmail.com" (falls back to "Connected as you" when no account
 * is known yet), "Login expired", a via-setup sentence, or "Not connected".
 * Shared by the panel row's tooltip and the gallery detail's "Your
 * connection" line.
 */
export function connectionStateLabel(state: ConnectionState, account: string | undefined, viaLabel: string | null): string {
  if (state === 'connected') return `Connected as ${account ?? 'you'}`;
  if (state === 'expired') return 'Login expired';
  return viaLabel ?? 'Not connected';
}

/** One connector, one line: logo, name, compact status. Opens the gallery's detail view on click — no other affordance on the row itself. The account (when known) isn't shown inline — it's in the row's own tooltip. */
function ConnectorRow({
  connector,
  globalSetup,
  onOpen,
}: {
  connector: RoomConnector;
  /** Your agents' own global MCP setup, so a connector one of them already reaches this way reads "Via Claude" instead of nagging you to connect it. */
  globalSetup: readonly GlobalServer[];
  onOpen: () => void;
}) {
  const def = connectorById(connector.id);
  const mine = connector.mine ?? 'not_connected';
  const viaLabel = mine === 'connected' ? null : viaGlobalSetupShortLabel(connector.id, globalSetup);
  const via: readonly AgentKind[] = mine === 'connected' ? [] : [...globalAgentsFor(connector.id, globalSetup)];
  const status = compactConnectorStatus(mine, viaLabel);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={connectionStateLabel(mine, connector.account, viaGlobalSetupLabel(connector.id, globalSetup))}
      className="hover:bg-bg-2 flex h-7 w-full min-w-0 items-center gap-2 rounded-control pr-2 pl-8 text-left transition-colors"
      data-testid="connector-row"
      data-connector={connector.id}
      data-state={mine}
    >
      {def ? (
        <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={16} via={via} />
      ) : (
        <span className="bg-bg-3 size-4 shrink-0 rounded" />
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">{connector.name}</span>
      <span className={cn('ml-auto flex shrink-0 items-center gap-1.5 text-2xs whitespace-nowrap', STATUS_TEXT_CLASS[status.tone])}>
        {status.tone === 'success' && <span className="bg-success size-1.5 rounded-full" />}
        {status.text}
      </span>
    </button>
  );
}

/**
 * The quiet collapsed line for the agents' own global setup: "Your agents
 * also bring N connectors from their own setup". It's read-only in the
 * panel — clicking it opens the gallery, whose own "From your agents' own
 * setup" section has the full grouped list.
 */
function GlobalSetupLine({ servers, onOpen }: { servers: readonly GlobalServer[]; onOpen: () => void }) {
  if (servers.length === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-7 w-full items-center gap-1.5 px-2 text-left text-2xs text-text-muted transition-colors hover:text-text-primary"
      data-testid="global-setup-line"
    >
      <span className="min-w-0 flex-1 truncate">
        Your agents also bring {servers.length} {servers.length === 1 ? 'connector' : 'connectors'} from their own setup
      </span>
      <ChevronRight className="size-3 shrink-0" strokeWidth={1.5} />
    </button>
  );
}

export function ConnectorsSection({
  snapshot,
  selfUserId,
  onOpenGallery,
  onOpenGlobalSetup,
  bindingId,
  globalSetup = [],
  onExpand,
}: {
  snapshot: RoomSnapshot;
  selfUserId: string;
  /** Opens the connector gallery beside the panel (see `ConnectorGallery`), optionally straight on one connector's detail view. */
  onOpenGallery?: (focus?: ConnectorId) => void;
  /** The "your agents also bring…" line: the gallery on the Installed scope, at that section. */
  onOpenGlobalSetup?: () => void;
  /** Keys this section's remembered expanded/collapsed state to its space. */
  bindingId: string;
  /** Your agents' own global MCP setup — loaded once per Room by `RoomView`, cheap to refresh on expand (main caches it). */
  globalSetup?: readonly GlobalServer[];
  /** Called the moment this section opens, so `RoomView` can refresh `globalSetup`. */
  onExpand?: () => void;
}) {
  const self = snapshot.members.find((m) => m.id === selfUserId);
  const canWrite = self?.role === 'owner' || self?.role === 'editor';
  // Collapsed by default; remembered per space.
  const [expanded, setExpanded] = useState(() => readPanelSectionExpanded(bindingId, 'connectors') ?? false);
  const toggleExpanded = () => {
    setExpanded((current) => {
      const next = !current;
      writePanelSectionExpanded(bindingId, 'connectors', next);
      if (next) onExpand?.();
      return next;
    });
  };

  const connectors = snapshot.connectors;
  // A connector one of your agents already reaches from its own global setup
  // doesn't need you to do anything — it's left out of the "to connect" count.
  const needsAction = connectors.filter(
    (c) => (c.mine ?? 'not_connected') !== 'connected' && !viaGlobalSetupShortLabel(c.id, globalSetup)
  );
  const anyExpired = needsAction.some((c) => c.mine === 'expired');

  return (
    <div className="flex flex-col" data-testid="connectors-section">
      <div className="flex h-8 shrink-0 items-center gap-2 px-2">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
          data-testid="connectors-summary-row"
        >
          <Plug className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
          <span className="text-xs text-text-primary">Connectors</span>
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            {!expanded && connectors.length > 0 && (
              <>
                <span className="flex items-center">
                  {connectors.slice(0, 4).map((c, i) => (
                    <ConnectorMark key={c.id} connector={c} size={14} className={cn('ring-bg-1 ring-1', i > 0 && '-ml-1')} />
                  ))}
                </span>
                <span className="font-mono text-2xs text-text-muted">{connectors.length}</span>
              </>
            )}
            {!expanded && needsAction.length > 0 && (
              <span className={cn('text-2xs whitespace-nowrap', anyExpired ? 'text-warning' : 'text-text-muted')}>
                {needsAction.length} to connect
              </span>
            )}
            <ChevronRight
              className={cn('size-3 shrink-0 text-text-muted transition-transform', expanded && 'rotate-90')}
              strokeWidth={1.5}
            />
          </span>
        </button>
        {canWrite && expanded && (
          <button
            type="button"
            onClick={() => onOpenGallery?.()}
            className="hover:bg-bg-2 ml-1 shrink-0 rounded-chip px-2 py-0.5 text-2xs text-text-muted transition-colors hover:text-text-primary"
            data-testid="connectors-add-toggle"
          >
            + Add
          </button>
        )}
      </div>

      {expanded && (
        <div className="popover-in flex shrink-0 flex-col pt-1 pb-1.5" data-testid="connectors-expanded">
          {connectors.length === 0 && (
            <p className="px-2 text-2xs text-text-muted" data-testid="connectors-empty">
              None yet. Add a connector your team uses; each person&rsquo;s agent reaches it with their own login.
            </p>
          )}

          {connectors.map((c) => (
            <ConnectorRow key={c.id} connector={c} globalSetup={globalSetup} onOpen={() => onOpenGallery?.(c.id as ConnectorId)} />
          ))}

          <GlobalSetupLine servers={globalSetup} onOpen={() => (onOpenGlobalSetup ?? onOpenGallery)?.()} />
        </div>
      )}
    </div>
  );
}
