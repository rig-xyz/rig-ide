import { ArrowLeft, Plug, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import {
  CONNECTOR_CATEGORIES,
  CONNECTORS,
  connectorById,
  type ConnectionState,
  type ConnectorCategory,
  type ConnectorDef,
  type ConnectorId,
  type GlobalServer,
} from '@shared/spaces/connectors';
import { connectorsApi } from '../connectors-api';
import { displayServerName, groupGlobalSetup, inGlobalSetupLabel, viaGlobalSetupLabel, viaGlobalSetupShortLabel } from '../global-setup';
import { ConnectorLogo } from '../logos';
import type { RelayRoomSource } from '../relay-room-source';
import type { RoomSnapshot } from '../types';
import { AGENT_NAME } from './identity';
import { compactConnectorStatus, type PendingConnect } from './connectors-panel';

/**
 * The connector gallery (connectors-spec.md, kit canvas board 8): opened from
 * the space panel — either to its grid (search, category chips, logo cards
 * grouped "In this space" / "Add to this space" / "Coming soon" / "From your
 * agents' own setup"), or straight to one connector's DETAIL view when a
 * panel row is clicked. It's a wide sheet beside the panel, not a modal —
 * the Room dims behind it. The detail view is where the actual connect,
 * disconnect and remove-from-space flows live; the grid's cards are just
 * entry points (their own "Add" pill still adds a not-yet-used tool without
 * a detour through the detail view).
 */

/** Tools we can't connect yet (each needs an app registered by Rig Labs); shown, not actionable. */
const SOON: Array<{ id: string; name: string; blurb: string; category: ConnectorCategory; brandFill: string; path: string }> = [
  { id: 'github', name: 'GitHub', blurb: 'Repos, pull requests and issues', category: 'Engineering', brandFill: 'currentColor', path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12' },
  { id: 'googledrive', name: 'Google Drive', blurb: 'Docs, Sheets and files', category: 'Docs & data', brandFill: '#4285F4', path: 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z' },
  { id: 'slack', name: 'Slack', blurb: 'Channels and threads', category: 'Customers & revenue', brandFill: '#E01E5A', path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z' },
  { id: 'figma', name: 'Figma', blurb: 'Designs and comments', category: 'Design', brandFill: '#F24E1E', path: 'M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z' },
  { id: 'hubspot', name: 'HubSpot', blurb: 'Contacts, deals and pipelines', category: 'Customers & revenue', brandFill: '#FF7A59', path: 'M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z' },
];

export function ConnectorGallery({
  snapshot,
  selfUserId,
  source,
  onClose,
  rightInset,
  globalSetup = [],
  focus = null,
}: {
  snapshot: RoomSnapshot;
  selfUserId: string;
  source: RelayRoomSource;
  onClose: () => void;
  /** Px from the Room's right edge: clears the floating space panel, so the sheet sits beside it. */
  rightInset: number;
  /** Your agents' own global MCP setup — a catalog tool one of them already reaches this way gets a footer note instead of a bare category label, and its own read-only section at the foot of the grid. */
  globalSetup?: readonly GlobalServer[];
  /** Opens straight on this connector's detail view (a space panel row was clicked) instead of the grid. */
  focus?: ConnectorId | null;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | 'All'>('All');
  const [detail, setDetail] = useState<ConnectorId | null>(focus);
  const [flow, setFlow] = useState<PendingConnect | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [armedRemove, setArmedRemove] = useState(false);
  // Your own logins, for tools the space doesn't use yet (connected ones add straight away).
  const [mine, setMine] = useState<Map<string, ConnectionState>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    void connectorsApi.list().then((statuses) => setMine(new Map(statuses.map((s) => [s.id, s.state]))));
  }, []);

  // A different row was clicked while the gallery was already open: jump to
  // its detail, abandoning any flow that was mid-way for the old one.
  useEffect(() => {
    if (flow && flow.id !== focus && flow.phase === 'waiting') void connectorsApi.cancel(flow.id as ConnectorId);
    setFlow(null);
    setArmedRemove(false);
    setError(null);
    setDetail(focus ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && flow?.phase !== 'waiting') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flow, onClose]);

  const inSpace = new Map(snapshot.connectors.map((c) => [c.id, c]));
  const self = snapshot.members.find((m) => m.id === selfUserId);
  const canWrite = self?.role === 'owner' || self?.role === 'editor';
  const q = query.trim().toLowerCase();
  const matches = (t: { name: string; blurb: string; category: string }) =>
    (category === 'All' || t.category === category) &&
    (!q || `${t.name} ${t.blurb} ${t.category}`.toLowerCase().includes(q));

  const inThisSpace = CONNECTORS.filter((c) => inSpace.has(c.id) && matches(c));
  const addable = CONNECTORS.filter((c) => !inSpace.has(c.id) && matches(c));
  const soon = SOON.filter(matches);
  const setupGroups = useMemo(() => groupGlobalSetup(globalSetup), [globalSetup]);
  const nothing = inThisSpace.length + addable.length + soon.length === 0;

  const categories = useMemo(() => ['All' as const, ...CONNECTOR_CATEGORIES], []);

  const fail = (id: string, message: string) => setError({ id, message });

  /**
   * The primary action, wherever it's triggered from (the grid card's "Add"
   * pill, or the detail view's own Connect/Reconnect/Add button): straight
   * to the space when you're already connected and it's new to the space,
   * otherwise opens the detail view mid-flow (consent, then the browser).
   */
  const startFlow = (def: ConnectorDef, isNew: boolean) => {
    setError(null);
    if (isNew && mine.get(def.id) === 'connected') {
      void source.addConnector(def.id).then((added) => {
        if (!added.ok) fail(def.id, added.message ?? "Couldn't add this to the space.");
      });
      return;
    }
    setDetail(def.id);
    setFlow({ id: def.id, phase: 'consent', isNew });
  };

  const go = () => {
    if (!flow) return;
    const { id, isNew } = flow;
    setFlow({ id, phase: 'waiting', isNew });
    void connectorsApi.connect(id as ConnectorId).then(async (result) => {
      setFlow(null);
      if (!result.ok) {
        if (result.reason !== 'cancelled') fail(id, result.message ?? `Couldn't connect to ${connectorById(id)?.name ?? id}.`);
        return;
      }
      setMine((prev) => new Map(prev).set(id, 'connected'));
      if (isNew) {
        const added = await source.addConnector(id);
        if (!added.ok) fail(id, added.message ?? "Couldn't add this to the space.");
      } else {
        await source.refreshConnections();
      }
    });
  };

  const cancel = () => {
    if (flow?.phase === 'waiting') void connectorsApi.cancel(flow.id as ConnectorId);
    setFlow(null);
  };

  const card = (def: ConnectorDef) => {
    const room = inSpace.get(def.id);
    const state: ConnectionState = room ? (room.mine ?? 'not_connected') : (mine.get(def.id) ?? 'not_connected');
    const viaLabel = state === 'connected' ? null : viaGlobalSetupShortLabel(def.id, globalSetup);
    const status = compactConnectorStatus(state, viaLabel);
    return (
      <div
        key={def.id}
        role="button"
        tabIndex={0}
        onClick={() => setDetail(def.id)}
        onKeyDown={(e) => e.key === 'Enter' && setDetail(def.id)}
        className="bg-bg-1 border-border-hairline hover:border-border-strong flex min-h-[7.5rem] cursor-pointer flex-col gap-2.5 rounded-card border p-3 transition-colors"
        data-testid="gallery-card"
        data-connector={def.id}
      >
        <div className="flex items-start gap-2.5">
          <span className="bg-bg-2 grid size-9 shrink-0 place-items-center rounded-control">
            <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={20} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <b className="truncate text-sm font-medium text-text-primary">{def.name}</b>
            <span className="text-xs text-text-secondary">{def.blurb}</span>
          </span>
        </div>
        <div className="mt-auto flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-2xs text-text-muted">
            {room ? (room.addedBy ? addedByLabel(snapshot, room.addedBy, selfUserId) : '') : (inGlobalSetupLabel(def.id, globalSetup) ?? def.category)}
          </span>
          {room ? (
            state === 'connected' ? (
              <span className="flex shrink-0 items-center gap-1.5 text-2xs text-text-secondary">
                <span className="bg-success size-1.5 rounded-full" />
                Connected as you
              </span>
            ) : (
              <span className={cn('shrink-0 text-2xs whitespace-nowrap', STATUS_CLASS[status.tone])}>{status.text}</span>
            )
          ) : (
            <GalleryPill
              accent
              onClick={(e) => {
                e.stopPropagation();
                startFlow(def, true);
              }}
            >
              Add
            </GalleryPill>
          )}
        </div>
      </div>
    );
  };

  const detailDef = detail ? connectorById(detail) : null;
  const detailRoom = detailDef ? (inSpace.get(detailDef.id) ?? null) : null;

  return (
    <>
      {/* The Room dims behind the sheet; clicking it closes the gallery. */}
      <button
        type="button"
        aria-label="Close the tool gallery"
        className="bg-bg-0/55 absolute inset-0 z-20 cursor-default"
        onClick={() => flow?.phase !== 'waiting' && onClose()}
        data-testid="gallery-backdrop"
      />
      <section
        className="popover-in border-border-hairline bg-bg-1/95 shadow-float absolute inset-y-3 z-30 flex w-[min(44rem,calc(100%-24rem))] min-w-[28rem] flex-col overflow-hidden rounded-card border backdrop-blur-xl"
        style={{ right: rightInset }}
        aria-label="Tools for this space"
        data-testid="connector-gallery"
      >
        <header className="border-border-hairline flex flex-col gap-3 border-b px-5 pt-4 pb-3">
          <div className="flex items-start gap-3">
            <div className="flex flex-1 flex-col gap-0.5">
              <h2 className="text-base font-semibold text-text-primary">Tools for {snapshot.name}</h2>
              <p className="text-xs text-text-muted">
                Everyone connects with their own login. What an agent reads shows up in the Room.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="bg-bg-2 hover:bg-bg-3 grid size-7 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:text-text-primary"
            >
              <X className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
          {!detailDef && (
            <>
              <label className="bg-bg-0 border-border-hairline focus-within:border-accent/60 flex h-9 items-center gap-2 rounded-control border px-3">
                <Search className="size-3.5 text-text-muted" strokeWidth={1.75} />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tools"
                  aria-label="Search tools"
                  className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                  data-testid="gallery-search"
                />
              </label>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    aria-pressed={category === c}
                    className={cn(
                      'h-7 rounded-full border px-3 text-xs whitespace-nowrap transition-colors',
                      category === c
                        ? 'border-text-primary bg-text-primary text-bg-0'
                        : 'border-border-hairline text-text-secondary hover:border-border-strong hover:text-text-primary'
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </>
          )}
        </header>

        {detailDef ? (
          <ConnectorDetail
            def={detailDef}
            inSpace={detailRoom !== null}
            state={detailRoom ? (detailRoom.mine ?? 'not_connected') : (mine.get(detailDef.id) ?? 'not_connected')}
            viaLabel={viaGlobalSetupLabel(detailDef.id, globalSetup)}
            canWrite={canWrite}
            addedByName={detailRoom?.addedBy ? addedByLabel(snapshot, detailRoom.addedBy, selfUserId) : null}
            flow={flow?.id === detailDef.id ? flow : null}
            error={error?.id === detailDef.id ? error.message : null}
            armedRemove={armedRemove}
            onBack={() => setDetail(null)}
            onStart={() => startFlow(detailDef, !detailRoom)}
            onGo={go}
            onCancel={cancel}
            onDisconnect={async () => {
              await connectorsApi.disconnect(detailDef.id);
              setMine((prev) => new Map(prev).set(detailDef.id, 'not_connected'));
              await source.refreshConnections();
            }}
            onArmRemove={() => setArmedRemove(true)}
            onRemove={async () => {
              setArmedRemove(false);
              const result = await source.removeConnector(detailDef.id);
              if (!result.ok) fail(detailDef.id, result.message ?? "Couldn't remove this from the space.");
              else setDetail(null);
            }}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            {inThisSpace.length > 0 && <GallerySection title="In this space">{inThisSpace.map(card)}</GallerySection>}
            {addable.length > 0 && <GallerySection title="Add to this space">{addable.map(card)}</GallerySection>}
            {soon.length > 0 && (
              <GallerySection title="Coming soon">
                {soon.map((t) => (
                  <div
                    key={t.id}
                    className="bg-bg-1 border-border-hairline flex min-h-[7.5rem] flex-col gap-2.5 rounded-card border p-3 opacity-55"
                    data-testid="gallery-soon"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className={cn('bg-bg-2 grid size-9 shrink-0 place-items-center rounded-control', t.brandFill === 'currentColor' && 'text-text-primary')}>
                        <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
                          <path fill={t.brandFill} d={t.path} />
                        </svg>
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
                        <b className="truncate text-sm font-medium text-text-primary">{t.name}</b>
                        <span className="text-xs text-text-secondary">{t.blurb}</span>
                      </span>
                    </div>
                    <span className="mt-auto text-2xs text-text-muted">Coming soon</span>
                  </div>
                ))}
              </GallerySection>
            )}
            {nothing && <p className="py-10 text-center text-xs text-text-muted">No tools match &ldquo;{query}&rdquo;.</p>}
            {setupGroups.length > 0 && (
              <section className="flex flex-col" data-testid="gallery-global-setup">
                <h3 className="pt-4 pb-2 text-sm font-medium text-text-primary">From your agents&rsquo; own setup</h3>
                <div className="flex flex-col gap-3">
                  {setupGroups.map((group) => (
                    <div key={group.agent} className="flex flex-col gap-1.5">
                      <span className="text-2xs font-medium text-text-muted">{AGENT_NAME[group.agent]}</span>
                      <div className="flex flex-col gap-1">
                        {group.servers.map((server, i) => {
                          const def = server.connectorId ? connectorById(server.connectorId) : null;
                          return (
                            <span
                              key={`${server.agent}-${server.name}-${i}`}
                              className="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary"
                            >
                              {def ? (
                                <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={16} />
                              ) : (
                                <Plug className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
                              )}
                              <span className="truncate">{displayServerName(server.name)}</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </section>
    </>
  );
}

const STATUS_CLASS: Record<ReturnType<typeof compactConnectorStatus>['tone'], string> = {
  success: 'text-text-secondary',
  warn: 'text-warning',
  muted: 'text-text-muted',
  accent: 'text-accent',
};

/**
 * A connector's detail view: opened either from a space panel row or from
 * clicking a gallery card. Everything actionable — connect/reconnect,
 * disconnect your own login, remove from the space — lives here; the grid
 * and the panel rows are just entry points onto it.
 */
function ConnectorDetail({
  def,
  inSpace,
  state,
  viaLabel,
  canWrite,
  addedByName,
  flow,
  error,
  armedRemove,
  onBack,
  onStart,
  onGo,
  onCancel,
  onDisconnect,
  onArmRemove,
  onRemove,
}: {
  def: ConnectorDef;
  /** Whether this connector is already used by the space, vs. one you're only previewing from "Add to this space". */
  inSpace: boolean;
  state: ConnectionState;
  viaLabel: string | null;
  canWrite: boolean;
  addedByName: string | null;
  flow: PendingConnect | null;
  error: string | null;
  armedRemove: boolean;
  onBack: () => void;
  onStart: () => void;
  onGo: () => void;
  onCancel: () => void;
  onDisconnect: () => Promise<void>;
  onArmRemove: () => void;
  onRemove: () => Promise<void>;
}) {
  const connected = state === 'connected';
  const expired = state === 'expired';
  const phase = flow?.phase ?? null;
  const stateLine = connected ? 'Connected as you' : expired ? 'Login expired' : (viaLabel ?? 'Not connected');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="gallery-detail" data-connector={def.id}>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text-primary"
        data-testid="gallery-detail-back"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        All tools
      </button>

      <div className="flex items-start gap-3">
        <span className="bg-bg-2 grid size-14 shrink-0 place-items-center rounded-card">
          <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={30} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5 pt-0.5 leading-tight">
          <h3 className="text-base font-semibold text-text-primary">{def.name}</h3>
          <p className="text-xs text-text-secondary">{def.blurb}</p>
          <span className="text-2xs text-text-muted">{def.category}</span>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs text-text-secondary" data-testid="gallery-detail-state">
          {(connected || expired) && <span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-warning')} />}
          {stateLine}
        </span>
        {inSpace && addedByName && <span className="text-2xs text-text-muted">{addedByName}</span>}
      </div>

      {error && (
        <p className="mt-3 text-2xs text-danger" data-testid="gallery-detail-error">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {phase === 'consent' ? (
          <div className="border-border-hairline bg-bg-2 flex flex-col gap-2 rounded-card border p-3 text-xs text-text-secondary" data-testid="gallery-detail-consent">
            <span>
              Results your agent gets from <b className="font-medium text-text-primary">{def.name}</b> will show up in this
              Room. You&rsquo;ll sign in to {def.name} in your browser; everyone else in the space connects with their own
              login.
            </span>
            <span className="flex gap-1.5">
              <GalleryPill accent onClick={onGo}>
                Continue in browser
              </GalleryPill>
              <GalleryPill onClick={onCancel}>Cancel</GalleryPill>
            </span>
          </div>
        ) : phase === 'waiting' ? (
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <DotMatrix state="waiting" size="sm" />
            Waiting for your browser…
            <GalleryPill onClick={onCancel}>Cancel</GalleryPill>
          </span>
        ) : (
          !(inSpace && connected) && (
            <span>
              <GalleryPill accent onClick={onStart}>
                {!inSpace ? 'Add' : expired ? 'Reconnect' : 'Connect'}
              </GalleryPill>
            </span>
          )
        )}

        {phase === null && (connected || (inSpace && canWrite)) && (
          <span className="flex items-center gap-2">
            {connected && <GalleryPill onClick={() => void onDisconnect()}>Disconnect my login</GalleryPill>}
            {inSpace && canWrite && (
              <GalleryPill danger={armedRemove} onClick={() => (armedRemove ? void onRemove() : onArmRemove())}>
                {armedRemove ? 'Remove for everyone?' : 'Remove from space'}
              </GalleryPill>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function addedByLabel(snapshot: RoomSnapshot, userId: string, selfUserId: string): string {
  if (userId === selfUserId) return 'Added by you';
  const name = snapshot.members.find((m) => m.id === userId)?.name ?? userId;
  return `Added by ${name}`;
}

function GallerySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="pt-4 pb-2 text-sm font-medium text-text-primary">{title}</h3>
      <div className="grid grid-cols-3 gap-2.5">{children}</div>
    </section>
  );
}

function GalleryPill({
  accent,
  danger,
  onClick,
  children,
}: {
  accent?: boolean;
  danger?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-6 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors',
        danger
          ? 'bg-danger/15 text-danger'
          : accent
            ? 'bg-accent-subtle text-accent hover:bg-accent/25'
            : 'text-text-muted hover:text-text-primary'
      )}
    >
      {children}
    </button>
  );
}
