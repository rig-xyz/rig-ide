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
 * something LIVE right now (`spaceIsActive`, `running.length > 0`; a
 * space that's merely recently-quiet stays in the Spaces card's own list,
 * not duplicated here). Replaces the old quiet-line "ACROSS YOUR RIGS"
 * with the mock's own card grammar: status tile + `# name` + faces + the
 * space's own Pulse line + a connector-logos meta row. Absent entirely
 * when nothing is active — no empty-state chrome for a section that's
 * allowed to just not apply.
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

  const active = spaceRows.filter((row) => spaceIsActive(statusByBinding.get(row.bindingId)));
  if (active.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-text-primary text-sm font-medium">Across your spaces</h2>
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
    </section>
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
