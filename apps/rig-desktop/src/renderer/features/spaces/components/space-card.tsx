import { FileText, Plug, Sparkles, Users } from 'lucide-react';
import { useMemo } from 'react';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import { agentLogoId, BrandLogo } from '../logos';
import { projectSessionCard } from '../projection';
import type { RoomSnapshot } from '../types';

const AGENT_NAME: Record<'claude' | 'codex', string> = { claude: 'Claude', codex: 'Codex' };
const MAX_ACTIVITY_ROWS = 5;

/**
 * Spaces (lane 2): the floating space card — reuses `workspace/pinned-
 * card.tsx`'s row grammar (icon · label ····· value, 28px rows, hairline
 * card) rather than inventing a new one. People (avatars), one row per
 * agent (logo + owner badge, name, model, a pulse dot while busy),
 * Connectors (logos), Skills, and Activity (files any session in this room
 * has touched, most recent first).
 */
export function SpaceCard({ snapshot }: { snapshot: RoomSnapshot }) {
  const activity = useMemo(() => {
    const rows: Array<{ path: string; owner: string; startedAt: string }> = [];
    const seen = new Set<string>();
    const runs = Object.values(snapshot.sessionMetaByRun).sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
    );
    for (const meta of runs) {
      const events = snapshot.sessionEventsByRun[meta.id] ?? [];
      const card = projectSessionCard(events);
      for (const output of card.outputs) {
        if (seen.has(output.path)) continue;
        seen.add(output.path);
        rows.push({ path: output.path, owner: meta.owner, startedAt: meta.startedAt });
      }
    }
    return rows.slice(0, MAX_ACTIVITY_ROWS);
  }, [snapshot.sessionMetaByRun, snapshot.sessionEventsByRun]);

  return (
    <div
      className="border-border-hairline bg-bg-1 shadow-float absolute top-3 right-4 z-20 flex w-[280px] flex-col gap-0.5 rounded-card border p-2"
      data-testid="space-card"
    >
      <p className="px-2 pt-1 pb-1 font-mono text-2xs tracking-wide text-text-muted uppercase">Space</p>

      <div className="flex h-7 items-center gap-2 rounded-control px-2">
        <Users className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
        <span className="text-xs text-text-primary">People</span>
        <span className="ml-auto flex items-center">
          {snapshot.members.map((m, i) => (
            <IdentityAvatar
              key={m.id}
              name={m.name}
              avatarUrl={null}
              sizeClassName="size-4"
              textClassName="text-2xs"
              className={cn('ring-bg-1 ring-1', i > 0 && '-ml-1', m.status === 'invited' && 'opacity-45')}
            />
          ))}
        </span>
      </div>

      {snapshot.agents.map((agent) => (
        <div key={`${agent.agent}-${agent.owner}`} className="flex h-7 items-center gap-2 rounded-control px-2">
          <span className="relative inline-flex size-4.5 shrink-0 items-center justify-center">
            <BrandLogo id={agentLogoId(agent.agent)} size={14} />
            <IdentityAvatar
              name={agent.owner}
              avatarUrl={null}
              sizeClassName="absolute -right-1 -bottom-1 size-3"
              textClassName="text-2xs"
              className="ring-bg-1 ring-1"
            />
          </span>
          <span className="min-w-0 truncate text-xs text-text-primary">{AGENT_NAME[agent.agent]}</span>
          <span className="ml-auto flex items-center gap-1.5 font-mono text-2xs text-text-muted">
            {agent.model}
            {agent.busy && <span className="bg-accent size-1.5 animate-pulse rounded-full" />}
          </span>
        </div>
      ))}

      {snapshot.connectors.length > 0 && (
        <div className="flex h-7 items-center gap-2 rounded-control px-2">
          <Plug className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
          <span className="text-xs text-text-primary">Connectors</span>
          <span className="ml-auto flex items-center gap-1">
            {snapshot.connectors.map((c) => (
              <BrandLogo key={c.id} id={c.logo} size={13} />
            ))}
          </span>
        </div>
      )}

      {snapshot.skills.map((skill) => (
        <div key={skill.cmd} className="flex h-7 items-center gap-2 rounded-control px-2">
          <Sparkles className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
          <span className="min-w-0 truncate text-xs text-text-primary">{skill.name}</span>
          <span className="ml-auto font-mono text-2xs text-text-muted">{skill.cmd}</span>
        </div>
      ))}

      {activity.length > 0 && (
        <>
          <p className="px-2 pt-2 pb-1 font-mono text-2xs tracking-wide text-text-muted uppercase">
            Activity
          </p>
          {activity.map((row) => (
            <div key={row.path} className="flex h-7 items-center gap-1.5 rounded-control px-2">
              <FileText className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
              <span className="min-w-0 truncate text-xs text-text-primary">{row.path.split('/').pop()}</span>
              <span className="ml-auto shrink-0 font-mono text-2xs text-text-muted">{row.owner}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
