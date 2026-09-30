import { ArrowLeft, Loader2, Plug, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import {
  CONNECTOR_CATEGORIES,
  CONNECTORS,
  connectorById,
  type ConnectionState,
  type ConnectionStatus,
  type ConnectorCategory,
  type ConnectorDef,
  type ConnectorId,
  type GlobalServer,
} from '@shared/spaces/connectors';
import { connectorsApi } from '../connectors-api';
import {
  globalAgentsFor,
  globalAgentsLabel,
  viaGlobalSetupLabel,
  viaGlobalSetupShortLabel,
  yourAgentsHaveItLabel,
} from '../global-setup';
import { ConnectorLogo, LogoTile } from '../logos';
import type { RelayRoomSource } from '../relay-room-source';
import type { AgentKind, RoomSnapshot } from '../types';
import { AGENT_NAME } from './identity';
import { compactConnectorStatus, connectionStateLabel, type PendingConnect } from './connectors-panel';

/** The gallery's own scope filter, alongside its category chips. */
type GalleryScope = 'all' | 'installed' | 'available';

const SCOPES: Array<{ id: GalleryScope; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'installed', label: 'Installed' },
  { id: 'available', label: 'Available' },
];

/** Shorter chip labels for the filter row; the shared category ids stay as `connectors.ts` defines them. */
const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  'Work tracking': 'Projects',
  'Docs & data': 'Docs',
  Design: 'Design',
  Analytics: 'Analytics',
  Engineering: 'Engineering',
  'Customers & revenue': 'Customers',
  Meetings: 'Meetings',
  Automation: 'Automation',
};

/** "claude.ai Linear" → "Linear", "plugin:acme-tools:launchdarkly" → "launchdarkly". The raw name still shows in a `title`. */
function cleanGlobalServerName(name: string): string {
  return name.replace(/^claude\.ai\s+/, '').replace(/^plugin:[^:]+:/, '');
}

/** One card for the "From your agents' own setup" grid: a catalog connector merges across agents (same `connectorId`); anything else stays one card per agent. */
interface SetupCard {
  key: string;
  connectorId: ConnectorId | null;
  name: string;
  rawName: string;
  agents: AgentKind[];
}

function buildSetupCards(servers: readonly GlobalServer[]): SetupCard[] {
  const byKey = new Map<string, SetupCard>();
  for (const server of servers) {
    const key = server.connectorId ?? `${server.agent}:${server.name}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.agents.includes(server.agent)) existing.agents.push(server.agent);
      continue;
    }
    byKey.set(key, {
      key,
      connectorId: server.connectorId,
      name: cleanGlobalServerName(server.name),
      rawName: server.name,
      agents: [server.agent],
    });
  }
  return [...byKey.values()];
}

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
  initialScope = 'all',
  initialSection = null,
}: {
  snapshot: RoomSnapshot;
  selfUserId: string;
  source: RelayRoomSource;
  onClose: () => void;
  /** Px from the Room's right edge: clears the floating space panel, so the sheet sits beside it. */
  rightInset: number;
  /** Your agents' own global MCP setup — a catalog connector one of them already reaches this way gets a footer note instead of a bare category label, and its own read-only section at the foot of the grid. */
  globalSetup?: readonly GlobalServer[];
  /** Opens straight on this connector's detail view (a space panel row was clicked) instead of the grid. */
  focus?: ConnectorId | null;
  /** The grid's scope filter to start on (the panel's "also bring" line wants 'installed'). */
  initialScope?: GalleryScope;
  /** Scrolls the grid to this section once opened. */
  initialSection?: 'global-setup' | null;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | 'All'>('All');
  const [scope, setScope] = useState<GalleryScope>(initialScope);
  const [detail, setDetail] = useState<ConnectorId | null>(focus);
  const [flow, setFlow] = useState<PendingConnect | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [armedRemove, setArmedRemove] = useState(false);
  // Your own logins (state + account), for connectors the space doesn't use yet (connected ones add straight away).
  const [mine, setMine] = useState<Map<string, ConnectionStatus>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);
  const globalSetupSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    void connectorsApi.list().then((statuses) => setMine(new Map(statuses.map((s) => [s.id, s]))));
    if (initialSection === 'global-setup') globalSetupSectionRef.current?.scrollIntoView({ block: 'start' });
    // Only meant to run once, against how the gallery was opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // 'installed' = already in the space, or one of your agents already reaches
  // it from its own setup; 'available' = not in the space yet (it may still
  // show up under 'installed' too, if your setup already reaches it).
  const inScope = (id: ConnectorId) => {
    if (scope === 'all') return true;
    if (scope === 'available') return !inSpace.has(id);
    return inSpace.has(id) || globalAgentsFor(id, globalSetup).size > 0;
  };

  const inThisSpace = CONNECTORS.filter((c) => inSpace.has(c.id) && matches(c) && inScope(c.id));
  const addable = CONNECTORS.filter((c) => !inSpace.has(c.id) && matches(c) && inScope(c.id));
  // Nothing here is installed or addable yet, so it only belongs under 'all'/'available'.
  const soon = scope === 'installed' ? [] : SOON.filter(matches);
  // Shows under 'all' and 'installed' only (connectors-spec.md's Surface).
  const setupCards = useMemo(() => (scope === 'available' ? [] : buildSetupCards(globalSetup)), [globalSetup, scope]);
  const setupCardsVisible = setupCards.filter((c) => {
    const def = c.connectorId ? connectorById(c.connectorId) : null;
    if (category !== 'All' && def?.category !== category) return false;
    if (q && !`${c.name} ${def?.blurb ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const nothing = inThisSpace.length + addable.length + soon.length + setupCardsVisible.length === 0;

  const categories = useMemo(() => ['All' as const, ...CONNECTOR_CATEGORIES], []);

  const fail = (id: string, message: string) => setError({ id, message });

  /**
   * The primary action, wherever it's triggered from (the grid card's "Add"
   * pill, or the detail view's own Connect/Reconnect/Add button): straight
   * to the space when it's new to the space and you can already reach it —
   * connected via rig, or one of your agents has it from its own setup (e.g.
   * a claude.ai connector: adding just declares it for the space, and that
   * agent keeps using its own connection; see `sessionConnectorsFor` in
   * main) — otherwise opens the detail view mid-flow (consent, then the browser).
   */
  const startFlow = (def: ConnectorDef, isNew: boolean) => {
    setError(null);
    if (isNew && (mine.get(def.id)?.state === 'connected' || globalAgentsFor(def.id, globalSetup).size > 0)) {
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
      // Re-fetch rather than just marking 'connected' locally, so the account
      // the connector just reported (once main starts filling it in) shows up too.
      const statuses = await connectorsApi.list();
      setMine(new Map(statuses.map((s) => [s.id, s])));
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
    const state: ConnectionState = room ? (room.mine ?? 'not_connected') : (mine.get(def.id)?.state ?? 'not_connected');
    const viaAgents: readonly AgentKind[] = state === 'connected' ? [] : [...globalAgentsFor(def.id, globalSetup)];
    const viaLabel = state === 'connected' ? null : viaGlobalSetupShortLabel(def.id, globalSetup);
    const status = compactConnectorStatus(state, viaLabel);
    const footerLabel = room
      ? room.addedBy
        ? addedByLabel(snapshot, room.addedBy, selfUserId)
        : ''
      : (yourAgentsHaveItLabel(new Set(viaAgents)) ?? def.category);
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
          <LogoTile px={36} via={viaAgents}>
            <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={20} />
          </LogoTile>
          <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <b className="truncate text-sm font-medium text-text-primary">{def.name}</b>
            <span className="text-xs text-text-secondary">{def.blurb}</span>
          </span>
        </div>
        <div className="mt-auto flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-2xs text-text-muted">{footerLabel}</span>
          {room ? (
            state === 'connected' ? (
              <span className="flex min-w-0 shrink items-center gap-1.5 text-2xs text-text-secondary">
                <span className="bg-success size-1.5 shrink-0 rounded-full" />
                <span className="truncate">Connected as {room.account ?? 'you'}</span>
              </span>
            ) : (
              <span className={cn('shrink-0 text-2xs whitespace-nowrap', STATUS_CLASS[status.tone])}>{status.text}</span>
            )
          ) : (
            <GalleryPill
              accent
              title={viaAgents.length > 0 ? declareHint(def.name, viaAgents) : undefined}
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
  // Which of your agents can reach this connector: a space connector (added
  // via rig) is wired into any of your agents' sessions; one only reached
  // from an agent's own global setup is just that agent.
  const detailAvailableAgents: AgentKind[] = detailDef
    ? detailRoom
      ? ['claude', 'codex']
      : [...globalAgentsFor(detailDef.id, globalSetup)]
    : [];
  const detailMcpHost = detailDef ? urlHost(detailDef.url) : '';
  const detailState: ConnectionState = detailDef
    ? detailRoom
      ? (detailRoom.mine ?? 'not_connected')
      : (mine.get(detailDef.id)?.state ?? 'not_connected')
    : 'not_connected';
  const detailAccount = detailDef ? (detailRoom?.account ?? mine.get(detailDef.id)?.account) : undefined;
  const detailViaAgents: readonly AgentKind[] = detailDef ? [...globalAgentsFor(detailDef.id, globalSetup)] : [];

  return (
    <>
      {/* The Room dims behind the sheet; clicking it closes the gallery. */}
      <button
        type="button"
        aria-label="Close the connector gallery"
        className="bg-bg-0/55 absolute inset-0 z-20 cursor-default"
        onClick={() => flow?.phase !== 'waiting' && onClose()}
        data-testid="gallery-backdrop"
      />
      <section
        className="popover-in border-border-hairline bg-bg-1/95 shadow-float absolute inset-y-3 z-30 flex w-[min(44rem,calc(100%-24rem))] min-w-[28rem] flex-col overflow-hidden rounded-card border backdrop-blur-xl"
        style={{ right: rightInset }}
        aria-label="Connectors for this space"
        data-testid="connector-gallery"
      >
        <header className="border-border-hairline flex flex-col gap-3 border-b px-5 pt-4 pb-3">
          <div className="flex items-start gap-3">
            <div className="flex flex-1 flex-col gap-0.5">
              <h2 className="text-base font-semibold text-text-primary">Connectors for {snapshot.name}</h2>
              <p className="text-xs text-text-muted">
                Everyone connects with their own login. What an agent reads shows up in the chat.
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
                  placeholder="Search connectors"
                  aria-label="Search connectors"
                  className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                  data-testid="gallery-search"
                />
              </label>
              <GalleryFilters scope={scope} setScope={setScope} category={category} setCategory={setCategory} categories={categories} />
            </>
          )}
        </header>

        {detailDef ? (
          <ConnectorDetail
            def={detailDef}
            inSpace={detailRoom !== null}
            state={detailState}
            account={detailAccount}
            viaLabel={viaGlobalSetupLabel(detailDef.id, globalSetup)}
            viaAgents={detailViaAgents}
            canWrite={canWrite}
            addedByName={detailRoom?.addedBy ? addedByLabel(snapshot, detailRoom.addedBy, selfUserId) : null}
            availableAgents={detailAvailableAgents}
            mcpHost={detailMcpHost}
            flow={flow?.id === detailDef.id ? flow : null}
            error={error?.id === detailDef.id ? error.message : null}
            armedRemove={armedRemove}
            onBack={() => setDetail(null)}
            onStart={() => startFlow(detailDef, !detailRoom)}
            onGo={go}
            onCancel={cancel}
            onDisconnect={async () => {
              await connectorsApi.disconnect(detailDef.id);
              setMine((prev) => new Map(prev).set(detailDef.id, { id: detailDef.id, state: 'not_connected' }));
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
            {nothing && <p className="py-10 text-center text-xs text-text-muted">No connectors match &ldquo;{query}&rdquo;.</p>}
            {setupCardsVisible.length > 0 && (
              <section className="flex flex-col" ref={globalSetupSectionRef} data-testid="gallery-global-setup">
                <h3 className="pt-4 pb-2 text-sm font-medium text-text-primary">From your agents&rsquo; own setup</h3>
                <div className="grid grid-cols-3 gap-2.5">
                  {setupCardsVisible.map((setupCard) => {
                    const def = setupCard.connectorId ? connectorById(setupCard.connectorId) : null;
                    const subtitle = `In your ${globalAgentsLabel(new Set(setupCard.agents))} setup`;
                    const body = (
                      <>
                        <LogoTile px={36} via={setupCard.agents}>
                          {def ? (
                            <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={20} />
                          ) : (
                            <Plug className="size-4 text-text-muted" strokeWidth={1.5} />
                          )}
                        </LogoTile>
                        <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
                          <b className="truncate text-sm font-medium text-text-primary" title={setupCard.rawName}>
                            {setupCard.name}
                          </b>
                          <span className="truncate text-2xs text-text-muted">{subtitle}</span>
                        </span>
                      </>
                    );
                    return def ? (
                      <div
                        key={setupCard.key}
                        role="button"
                        tabIndex={0}
                        onClick={() => setDetail(def.id)}
                        onKeyDown={(e) => e.key === 'Enter' && setDetail(def.id)}
                        className="bg-bg-1 border-border-hairline hover:border-border-strong flex min-h-[3.5rem] cursor-pointer items-center gap-2.5 rounded-card border p-3 transition-colors"
                        data-testid="gallery-setup-card"
                        data-connector={def.id}
                      >
                        {body}
                      </div>
                    ) : (
                      <div
                        key={setupCard.key}
                        className="bg-bg-1 border-border-hairline flex min-h-[3.5rem] items-center gap-2.5 rounded-card border p-3 opacity-80"
                        data-testid="gallery-setup-card"
                      >
                        {body}
                      </div>
                    );
                  })}
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
 * clicking a gallery card. Three separate, clearly-labeled parts rather
 * than one big card (Dylan): a plain header, "Your connection" (your own
 * login — connect/reconnect/disconnect, available to anyone), "In this
 * space" (whether the space uses it at all — add/remove, owners/editors
 * only), and a quiet "Details" list. Everything actionable lives here; the
 * grid and the panel rows are just entry points onto it.
 */
function ConnectorDetail({
  def,
  inSpace,
  state,
  account,
  viaLabel,
  viaAgents,
  canWrite,
  addedByName,
  availableAgents,
  mcpHost,
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
  /** Who you're signed in as there, when known (`RoomConnector.account`/`ConnectionStatus.account`). */
  account: string | undefined;
  viaLabel: string | null;
  /** Agents that already reach this connector from their own global setup — the header logo's "via" badge, shown only while you haven't connected it yourself. */
  viaAgents: readonly AgentKind[];
  canWrite: boolean;
  addedByName: string | null;
  /** Which of your agents can reach this connector: both, for a space connector; just the one, for a global-setup-only match. */
  availableAgents: AgentKind[];
  /** The connector's MCP host, shown in muted text for transparency (e.g. "mcp.notion.com"). */
  mcpHost: string;
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
  const connectionLine = connectionStateLabel(state, account, viaLabel);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="gallery-detail" data-connector={def.id}>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text-primary"
        data-testid="gallery-detail-back"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        All connectors
      </button>

      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 pt-2">
        <div className="flex items-start gap-3">
          <LogoTile px={48} via={connected ? [] : viaAgents}>
            <ConnectorLogo id={def.id} name={def.name} brand={def.brand} size={26} />
          </LogoTile>
          <div className="flex min-w-0 flex-col gap-1 pt-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-text-primary">{def.name}</h3>
              <span className="bg-bg-2 rounded-full px-2 py-0.5 text-2xs text-text-secondary">{def.category}</span>
            </div>
            <p className="text-xs text-text-secondary">{def.blurb}</p>
          </div>
        </div>

        {error && (
          <p className="text-2xs text-danger" data-testid="gallery-detail-error">
            {error}
          </p>
        )}

        <DetailSection title="Your connection">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary" data-testid="gallery-detail-state">
              {(connected || expired) && <span className={cn('size-1.5 shrink-0 rounded-full', connected ? 'bg-success' : 'bg-warning')} />}
              <span className="truncate">{connectionLine}</span>
            </span>
            {phase === null && (
              <span className="flex shrink-0 items-center gap-2">
                {connected ? (
                  <DetailPill onClick={() => void onDisconnect()}>Disconnect</DetailPill>
                ) : inSpace && !coversAllAgents(viaAgents) ? (
                  <DetailPill accent onClick={onStart}>
                    {expired ? 'Reconnect' : viaAgents.length > 0 ? 'Connect here' : 'Connect'}
                  </DetailPill>
                ) : null /* not in the space yet: "Add to space" below connects you as part of adding it */}
              </span>
            )}
          </div>
          {!connected && viaAgents.length > 0 && inSpace && phase === null && (
            <p className="text-2xs leading-relaxed text-text-muted" data-testid="gallery-detail-via-hint">
              {viaHint(viaAgents)}
            </p>
          )}
          {phase === 'consent' && (
            <div className="border-border-hairline bg-bg-2 flex flex-col gap-2 rounded-card border p-3 text-xs text-text-secondary" data-testid="gallery-detail-consent">
              <span>
                Results your agent gets from <b className="font-medium text-text-primary">{def.name}</b> will show up in this
                chat. You&rsquo;ll sign in to {def.name} in your browser; everyone else in the space connects with their own
                login.
              </span>
              <span className="flex gap-1.5">
                <GalleryPill accent onClick={onGo}>
                  Continue in browser
                </GalleryPill>
                <GalleryPill onClick={onCancel}>Cancel</GalleryPill>
              </span>
            </div>
          )}
          {phase === 'waiting' && (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <Loader2 className="size-3 animate-spin text-text-muted" strokeWidth={2} />
              Waiting for your browser…
              <GalleryPill onClick={onCancel}>Cancel</GalleryPill>
            </span>
          )}
        </DetailSection>

        <DetailSection title="In this space">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-text-secondary">{inSpace ? (addedByName ?? 'Added') : 'Not in this space yet'}</span>
            {canWrite &&
              phase === null &&
              (inSpace ? (
                <DetailPill danger={armedRemove} onClick={() => (armedRemove ? void onRemove() : onArmRemove())}>
                  {armedRemove ? 'Remove for everyone?' : 'Remove'}
                </DetailPill>
              ) : (
                <DetailPill accent onClick={onStart}>
                  Add to space
                </DetailPill>
              ))}
          </div>
          {!inSpace && viaAgents.length > 0 && phase === null && (
            <p className="text-2xs leading-relaxed text-text-muted" data-testid="gallery-detail-declare-hint">
              {declareHint(def.name, viaAgents)}
            </p>
          )}
        </DetailSection>

        <DetailSection title="Details">
          <dl className="flex flex-col gap-1.5">
            {availableAgents.length > 0 && (
              <div className="flex items-center justify-between gap-3 text-2xs">
                <dt className="text-text-muted">Available to</dt>
                <dd className="text-text-secondary">{availableAgents.map((a) => AGENT_NAME[a]).join(', ')}</dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 text-2xs">
              <dt className="text-text-muted">Server</dt>
              <dd className="text-text-secondary">{mcpHost}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 text-2xs">
              <dt className="text-text-muted">Category</dt>
              <dd className="text-text-secondary">{def.category}</dd>
            </div>
          </dl>
        </DetailSection>
      </div>
    </div>
  );
}

/** Whether every agent rig runs already has this tool from its own setup — then a rig login would never be used (the agent's own connection wins). */
function coversAllAgents(via: readonly AgentKind[]): boolean {
  return via.includes('claude') && via.includes('codex');
}

/**
 * For a space connector one of your agents already reaches through its own
 * setup: it already works for that agent here, and that agent keeps using
 * its own connection (rig never injects a second one for it). "Connect here"
 * only matters for your other agent.
 */
function viaHint(via: readonly AgentKind[]): string {
  const names = via.map((a) => AGENT_NAME[a]).join(' and ');
  const others = (['claude', 'codex'] as const).filter((a) => !via.includes(a)).map((a) => AGENT_NAME[a]);
  const works = `Already works here: your ${names} uses ${via.length > 1 ? 'their' : 'its'} own connection, so you don’t need to sign in again.`;
  return others.length > 0 ? `${works} Connect here only if you also want your ${others.join(' and ')} to use it.` : works;
}

/**
 * What "Add to space" means for a tool one of your agents already has from
 * its own setup: no sign-in for you, it just tells the space the tool is
 * used here, so everyone else sees it and connects their own login.
 */
function declareHint(name: string, via: readonly AgentKind[]): string {
  const names = via.map((a) => AGENT_NAME[a]).join(' and ');
  return `${name} already works for your ${names} here, through ${via.length > 1 ? 'their' : 'its'} own connection. Adding it won’t ask you to sign in again: it tells everyone in the space it’s used here, so they can connect their own.`;
}

/** One block of the detail view — a quiet label plus its content, separated from its neighbors by space and a hairline rather than boxed (Dylan: no more one big card mixing everything). */

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-border-hairline flex flex-col gap-2.5 border-t pt-5" data-testid="gallery-detail-section">
      <h4 className="text-xs font-medium text-text-secondary">{title}</h4>
      {children}
    </section>
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
  title,
  onClick,
  children,
}: {
  accent?: boolean;
  danger?: boolean;
  title?: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
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

/** The detail view's own, roomier action pills — primary (accent) Connect/Reconnect, quiet secondary ones for Disconnect/Remove. */
function DetailPill({
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
        'h-8 rounded-full px-4 text-xs font-medium whitespace-nowrap transition-colors',
        danger
          ? 'bg-danger/15 text-danger hover:bg-danger/25'
          : accent
            ? 'bg-accent-subtle text-accent hover:bg-accent/25'
            : 'bg-bg-2 text-text-secondary hover:bg-bg-3 hover:text-text-primary'
      )}
    >
      {children}
    </button>
  );
}

/** The one-line scope + category filter row: scope first, then the category chips, in a single non-wrapping row that scrolls horizontally with a soft edge fade once it overflows. */
function GalleryFilters({
  scope,
  setScope,
  category,
  setCategory,
  categories,
}: {
  scope: GalleryScope;
  setScope: (scope: GalleryScope) => void;
  category: ConnectorCategory | 'All';
  setCategory: (category: ConnectorCategory | 'All') => void;
  categories: readonly (ConnectorCategory | 'All')[];
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const update = () =>
      setFade({
        left: el.scrollLeft > 1,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  const chipClass = (active: boolean) =>
    cn(
      'h-7 shrink-0 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors',
      active
        ? 'border-text-primary bg-text-primary text-bg-0'
        : 'border-border-hairline text-text-secondary hover:border-border-strong hover:text-text-primary'
    );

  return (
    <div className="relative pb-1">
      <div
        ref={rowRef}
        className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid="gallery-filters"
      >
        <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Scope">
          {SCOPES.map((s) => (
            <button key={s.id} type="button" onClick={() => setScope(s.id)} aria-pressed={scope === s.id} className={chipClass(scope === s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <span className="bg-border-hairline h-4 w-px shrink-0" aria-hidden />
        <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Categories">
          {categories.map((c) => (
            <button key={c} type="button" onClick={() => setCategory(c)} aria-pressed={category === c} className={chipClass(category === c)}>
              {c === 'All' ? 'All categories' : CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
      </div>
      {fade.left && (
        <div className="from-bg-1 pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r to-transparent" aria-hidden />
      )}
      {fade.right && (
        <div className="from-bg-1 pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l to-transparent" aria-hidden />
      )}
    </div>
  );
}

/** The connector's MCP host, e.g. `https://mcp.notion.com/mcp` → "mcp.notion.com" — shown in the detail status card for transparency. */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
