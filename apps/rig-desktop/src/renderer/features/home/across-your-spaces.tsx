import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { connectorById } from '@shared/spaces/connectors';
import { ConnectorLogo } from '@renderer/features/spaces/logos';
import type { RigSpaceStatus } from '@shared/rig/space-status';
import { PULSE_QUERY_KEY } from './briefing-spine';
import type { HomeRigRow } from './home-sections';
import { deriveSpaceStatusLine, spaceIsActive } from './space-status-state';
import { SpaceStatusTile } from './space-status-tile';
import { Faces } from './spaces-card';

/**
 * "Across your spaces" (design doc "9a") — one richer card per space with
 * something LIVE right now (`spaceIsActive`, `running.length > 0`).
 * Replaces the old quiet-line "ACROSS YOUR RIGS" with the mock's own card
 * grammar: status tile + `# name` + faces + the space's own Pulse line + a
 * connector-logos meta row.
 *
 * Polish round 2, lane F (Dylan: "Home is never blank"): every OTHER space
 * — recently-quiet or never-active — now gets its own compact one-line row
 * below the active cards (`QuietSpaceRow`), instead of being dropped
 * entirely. The whole section is still absent only when there are truly no
 * spaces at all (`spaceRows.length === 0` — the Spaces card's own empty
 * state already covers that case).
 */
export function AcrossYourSpaces({
  spaceRows,
  statusByBinding,
  onOpenPath,
}: {
  spaceRows: readonly HomeRigRow[];
  statusByBinding: ReadonlyMap<string, RigSpaceStatus>;
  onOpenPath: (path: string) => void;
}) {
  const pulseQuery = useQuery({
    queryKey: PULSE_QUERY_KEY,
    queryFn: () => rpc.rig.pulse.get({}),
    staleTime: 60_000,
  });
  const perRigLine = new Map(
    (pulseQuery.data?.success ? pulseQuery.data.data.briefing.perRig : []).map((p) => [p.bindingId, p.line])
  );

  if (spaceRows.length === 0) return null;

  const active = spaceRows.filter((row) => spaceIsActive(statusByBinding.get(row.bindingId)));
  const quiet = spaceRows.filter((row) => !spaceIsActive(statusByBinding.get(row.bindingId)));

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-text-primary text-sm font-medium">Across your spaces</h2>
      {active.length > 0 && (
        <div className="flex flex-col gap-2">
          {active.map((row) => (
            <ActiveSpaceCard
              key={row.bindingId}
              row={row}
              status={statusByBinding.get(row.bindingId)}
              line={perRigLine.get(row.bindingId) ?? null}
              onOpenPath={onOpenPath}
            />
          ))}
        </div>
      )}
      {quiet.length > 0 && (
        <div className="flex flex-col">
          {quiet.map((row) => (
            <QuietSpaceRow
              key={row.bindingId}
              row={row}
              status={statusByBinding.get(row.bindingId)}
              onOpenPath={onOpenPath}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** One quiet/never-active space, collapsed to a single row — status tile, `# name`, and the same muted status line words the richer card uses, just without the faces/Pulse-line/connector rows a quiet space has nothing live to say through. */
function QuietSpaceRow({
  row,
  status,
  onOpenPath,
}: {
  row: HomeRigRow;
  status: RigSpaceStatus | undefined;
  onOpenPath: (path: string) => void;
}) {
  const path = row.kind === 'local' ? row.path : null;
  return (
    <button
      type="button"
      onClick={() => path && onOpenPath(path)}
      disabled={!path}
      title={path ?? undefined}
      className="hover:bg-bg-2 flex min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors disabled:cursor-default"
    >
      <SpaceStatusTile status={status} size="sm" />
      <span className="text-text-muted shrink-0 font-mono text-sm">#</span>
      <span className="text-text-primary min-w-0 flex-1 truncate text-sm">{row.name}</span>
      <span className="text-text-muted shrink-0 truncate text-xs">{deriveSpaceStatusLine(status, Date.now())}</span>
    </button>
  );
}

function ActiveSpaceCard({
  row,
  status,
  line,
  onOpenPath,
}: {
  row: HomeRigRow;
  status: RigSpaceStatus | undefined;
  line: string | null;
  onOpenPath: (path: string) => void;
}) {
  const path = row.kind === 'local' ? row.path : null;
  const connectorsQuery = useQuery({
    queryKey: ['rig', 'spacesConnection', 'listConnectors', row.bindingId],
    queryFn: () => rpc.rig.spacesConnection.listConnectors({ bindingId: row.bindingId }),
    staleTime: 60_000,
  });
  const connectorIds = connectorsQuery.data?.success ? connectorsQuery.data.data.map((c) => c.connectorId) : [];

  return (
    <div className="border-border-hairline bg-bg-1 flex flex-col gap-2 rounded-card border p-3">
      <div className="flex items-center gap-2.5">
        <SpaceStatusTile status={status} />
        <button
          type="button"
          onClick={() => path && onOpenPath(path)}
          disabled={!path}
          className="text-text-primary flex min-w-0 items-center gap-1 text-left text-sm font-medium disabled:cursor-default"
        >
          <span className="text-text-muted font-mono">#</span>
          <span className="truncate">{row.name}</span>
        </button>
        <Faces bindingId={row.bindingId} />
        <span className="text-text-muted ml-auto shrink-0 truncate text-xs">
          {deriveSpaceStatusLine(status, Date.now())}
        </span>
      </div>
      {line && <p className="text-text-secondary text-sm leading-relaxed">{line}</p>}
      {connectorIds.length > 0 && (
        <div className="flex items-center gap-1.5">
          {connectorIds.map((id) => {
            const def = connectorById(id);
            return def ? <ConnectorLogo key={id} id={id} name={def.name} brand={def.brand} size={13} /> : null;
          })}
        </div>
      )}
    </div>
  );
}
