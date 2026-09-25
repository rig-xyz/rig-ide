import { Search, X } from 'lucide-react';
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
} from '@shared/spaces/connectors';
import { connectorsApi } from '../connectors-api';
import { ConnectorLogo } from '../logos';
import type { RelayRoomSource } from '../relay-room-source';
import type { RoomSnapshot } from '../types';

/**
 * The connector gallery (connectors-spec.md, kit canvas board 8): opened from
 * the space panel's "+ Add", a wide sheet beside the panel, not a modal. Search,
 * category chips, and logo cards in three groups: the tools this space already
 * uses (with your own login state), the ones you can add, and the ones that
 * need a rig-registered app first ("Soon"). Adding or connecting happens on the
 * card itself: its consent line, then waiting for your browser.
 */

/** Tools we can't connect yet (each needs an app registered by Rig Labs); shown, not actionable. */
const SOON: Array<{ id: string; name: string; blurb: string; category: ConnectorCategory; brandFill: string; path: string }> = [
  { id: 'github', name: 'GitHub', blurb: 'Repos, pull requests and issues', category: 'Engineering', brandFill: 'currentColor', path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12' },
  { id: 'googledrive', name: 'Google Drive', blurb: 'Docs, Sheets and files', category: 'Docs & data', brandFill: '#4285F4', path: 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z' },
  { id: 'slack', name: 'Slack', blurb: 'Channels and threads', category: 'Customers & revenue', brandFill: '#E01E5A', path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z' },
  { id: 'figma', name: 'Figma', blurb: 'Designs and comments', category: 'Design', brandFill: '#F24E1E', path: 'M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z' },
  { id: 'hubspot', name: 'HubSpot', blurb: 'Contacts, deals and pipelines', category: 'Customers & revenue', brandFill: '#FF7A59', path: 'M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z' },
];

type Flow = { id: ConnectorId; phase: 'consent' | 'waiting'; isNew: boolean };

export function ConnectorGallery({
  snapshot,
  source,
  onClose,
  rightInset,
}: {
  snapshot: RoomSnapshot;
  source: RelayRoomSource;
  onClose: () => void;
  /** Px from the Room's right edge: clears the floating space panel, so the sheet sits beside it. */
  rightInset: number;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | 'All'>('All');
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  // Your own logins, for tools the space doesn't use yet (connected ones add straight away).
  const [mine, setMine] = useState<Map<string, ConnectionState>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    void connectorsApi.list().then((statuses) => setMine(new Map(statuses.map((s) => [s.id, s.state]))));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && flow?.phase !== 'waiting') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flow, onClose]);

  const inSpace = new Map(snapshot.connectors.map((c) => [c.id, c]));
  const q = query.trim().toLowerCase();
  const matches = (t: { name: string; blurb: string; category: string }) =>
    (category === 'All' || t.category === category) &&
    (!q || `${t.name} ${t.blurb} ${t.category}`.toLowerCase().includes(q));

  const inThisSpace = CONNECTORS.filter((c) => inSpace.has(c.id) && matches(c));
  const addable = CONNECTORS.filter((c) => !inSpace.has(c.id) && matches(c));
  const soon = SOON.filter(matches);
  const nothing = inThisSpace.length + addable.length + soon.length === 0;

  const categories = useMemo(() => ['All' as const, ...CONNECTOR_CATEGORIES], []);

  const fail = (id: string, message: string) => setError({ id, message });

  const add = async (def: ConnectorDef) => {
    setError(null);
    if (mine.get(def.id) === 'connected') {
      const added = await source.addConnector(def.id);
      if (!added.ok) fail(def.id, added.message ?? "Couldn't add this to the space.");
      return;
    }
    setFlow({ id: def.id, phase: 'consent', isNew: true });
  };

  const go = () => {
    if (!flow) return;
    const { id, isNew } = flow;
    setFlow({ id, phase: 'waiting', isNew });
    void connectorsApi.connect(id).then(async (result) => {
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
    if (flow?.phase === 'waiting') void connectorsApi.cancel(flow.id);
    setFlow(null);
  };

  const card = (def: ConnectorDef) => {
    const room = inSpace.get(def.id);
    const state = room ? (room.mine ?? 'not_connected') : null;
    const active = flow?.id === def.id ? flow : null;
    return (
      <div
        key={def.id}
        className={cn(
          'bg-bg-1 border-border-hairline hover:border-border-strong flex min-h-[7.5rem] flex-col gap-2.5 rounded-card border p-3 transition-colors',
          active && 'border-accent/50 col-span-2'
        )}
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
        {active?.phase === 'consent' && (
          <p className="text-xs text-text-secondary" data-testid="gallery-consent">
            Results your agent gets from <b className="font-medium text-text-primary">{def.name}</b> will show up in this
            Room. You&rsquo;ll sign in to {def.name} in your browser; everyone else in the space connects with their own
            login.
          </p>
        )}
        {error?.id === def.id && <p className="text-2xs text-danger">{error.message}</p>}
        <div className="mt-auto flex items-center gap-2">
          <span className="text-2xs text-text-muted">
            {active ? '' : room ? (room.addedBy ? addedByLabel(snapshot, room.addedBy) : '') : def.category}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            {active?.phase === 'waiting' ? (
              <>
                <DotMatrix state="waiting" size="sm" />
                <span className="text-2xs text-text-muted">Waiting for your browser…</span>
                <GalleryPill onClick={cancel}>Cancel</GalleryPill>
              </>
            ) : active?.phase === 'consent' ? (
              <>
                <GalleryPill onClick={cancel}>Cancel</GalleryPill>
                <GalleryPill accent onClick={go}>
                  Continue in browser
                </GalleryPill>
              </>
            ) : state === 'connected' ? (
              <span className="flex items-center gap-1.5 text-2xs text-text-secondary">
                <span className="bg-success size-1.5 rounded-full" />
                Connected as you
              </span>
            ) : state ? (
              <GalleryPill accent onClick={() => setFlow({ id: def.id, phase: 'consent', isNew: false })}>
                {state === 'expired' ? 'Reconnect' : 'Connect'}
              </GalleryPill>
            ) : (
              <GalleryPill accent onClick={() => void add(def)}>
                Add
              </GalleryPill>
            )}
          </span>
        </div>
      </div>
    );
  };

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
        </header>

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
        </div>
      </section>
    </>
  );
}

function addedByLabel(snapshot: RoomSnapshot, userId: string): string {
  const name = snapshot.members.find((m) => m.id === userId)?.name ?? userId;
  return `Added by ${name}`;
}

function GallerySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="pt-4 pb-2 font-mono text-2xs tracking-wide text-text-muted uppercase">{title}</h3>
      <div className="grid grid-cols-3 gap-2.5">{children}</div>
    </section>
  );
}

function GalleryPill({ accent, onClick, children }: { accent?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-6 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors',
        accent ? 'bg-accent-subtle text-accent hover:bg-accent/25' : 'text-text-muted hover:text-text-primary'
      )}
    >
      {children}
    </button>
  );
}
