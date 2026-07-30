import { ChevronDown, Circle, CircleCheck, CircleSlash, LoaderCircle } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { events } from '@renderer/lib/ipc';
import { Badge } from '@renderer/lib/ui/badge';
import { cn } from '@renderer/utils/utils';
import {
  rigTasksUpdateChannel,
  type RigIntentView,
  type RigTasksSnapshot,
  type RigUiStatus,
} from '@shared/rig/contract';

const STATUS_SECTIONS: { status: RigUiStatus; label: string }[] = [
  { status: 'doing', label: 'In progress' },
  { status: 'todo', label: 'To do' },
  { status: 'done', label: 'Done' },
];

function StatusGlyph({ status }: { status: RigUiStatus }) {
  switch (status) {
    case 'doing':
      return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-foreground-info" />;
    case 'done':
      return <CircleCheck className="size-3.5 shrink-0 text-foreground-success" />;
    case 'abandoned':
      return <CircleSlash className="size-3.5 shrink-0 text-foreground-muted" />;
    default:
      return <Circle className="size-3.5 shrink-0 text-foreground-muted" />;
  }
}

function AgentChip({ agent }: { agent: string }) {
  return (
    <Badge variant="secondary" className="shrink-0">
      {agent}
    </Badge>
  );
}

function IntentRow({ intent }: { intent: RigIntentView }) {
  const muted = intent.uiStatus === 'done' || intent.uiStatus === 'abandoned';
  return (
    <div className="flex h-7 min-w-0 items-center gap-1.5">
      <StatusGlyph status={intent.uiStatus} />
      <span
        title={intent.title}
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          muted ? 'text-foreground-muted' : 'text-foreground',
          intent.uiStatus === 'done' && 'line-through'
        )}
      >
        {intent.title}
      </span>
      <AgentChip agent={intent.agent} />
    </div>
  );
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2">
      <span className="text-xs font-medium text-foreground-muted">{label}</span>
      <Badge variant="secondary" className="shrink-0">
        {count}
      </Badge>
    </div>
  );
}

function ConnectionIndicator({ snapshot }: { snapshot: RigTasksSnapshot }) {
  if (snapshot.error) {
    return (
      <span className="flex min-w-0 items-center gap-1.5" title={snapshot.error}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground-warning" />
        <span className="max-w-40 truncate text-xs text-foreground-warning">{snapshot.error}</span>
      </span>
    );
  }
  if (snapshot.connected) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground-success" />
        {snapshot.bindingId && (
          <span className="text-xs text-foreground-muted" title={snapshot.bindingId}>
            {snapshot.bindingId.slice(0, 8)}
          </span>
        )}
      </span>
    );
  }
  return null;
}

function formatUpdatedAgo(updatedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (seconds < 60) return `updated ${seconds}s ago`;
  return `updated ${Math.round(seconds / 60)}m ago`;
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export const RigTasksPanel = observer(function RigTasksPanel() {
  const [snapshot, setSnapshot] = useState<RigTasksSnapshot | null>(null);
  const [showAbandoned, setShowAbandoned] = useState(false);

  useEffect(() => events.on(rigTasksUpdateChannel, setSnapshot), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3.5">
        <span className="truncate text-sm text-foreground-muted">Rig Tasks</span>
        {snapshot && <ConnectionIndicator snapshot={snapshot} />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3.5 pb-2">
        {snapshot === null ? (
          <p className="text-sm text-foreground-muted">Waiting for rig bridge…</p>
        ) : snapshot.workspacePath === null ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-foreground-muted">Not a rig workspace</p>
            <p className="text-xs text-foreground-muted">
              Open a project with a .rig binding to see agent tasks.
            </p>
          </div>
        ) : (
          <RigTasksBoard
            snapshot={snapshot}
            showAbandoned={showAbandoned}
            onToggleAbandoned={() => setShowAbandoned((v) => !v)}
          />
        )}
      </div>
      {snapshot?.workspacePath != null && (
        <div className="shrink-0 border-t border-border px-3.5 py-1.5">
          <p className="truncate text-xs text-foreground-muted" title={snapshot.workspacePath}>
            {basename(snapshot.workspacePath)} · {formatUpdatedAgo(snapshot.updatedAt)}
          </p>
        </div>
      )}
    </div>
  );
});

function RigTasksBoard({
  snapshot,
  showAbandoned,
  onToggleAbandoned,
}: {
  snapshot: RigTasksSnapshot;
  showAbandoned: boolean;
  onToggleAbandoned: () => void;
}) {
  const sessions = snapshot.intents.filter((intent) => intent.parentIntentId === null);
  const tasks = snapshot.intents.filter((intent) => intent.parentIntentId !== null);

  if (snapshot.intents.length === 0) {
    return (
      <p className="text-sm text-foreground-muted">No agent tasks yet — start an agent session.</p>
    );
  }

  const abandoned = tasks.filter((task) => task.uiStatus === 'abandoned');

  return (
    <div className="flex flex-col">
      {sessions.length > 0 && (
        <div className="flex flex-col">
          <SectionLabel label="Sessions" count={sessions.length} />
          {sessions.map((session) => (
            <div key={session.id} className="flex h-7 min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  session.status === 'open' ? 'bg-foreground-success' : 'bg-foreground-muted'
                )}
                title={session.status}
              />
              <span
                title={session.title}
                className="min-w-0 flex-1 truncate text-sm text-foreground"
              >
                {session.title}
              </span>
              <AgentChip agent={session.agent} />
            </div>
          ))}
        </div>
      )}
      {STATUS_SECTIONS.map(({ status, label }) => {
        const items = tasks.filter((task) => task.uiStatus === status);
        if (items.length === 0) return null;
        return (
          <div key={status} className="flex flex-col">
            <SectionLabel label={label} count={items.length} />
            {items.map((task) => (
              <IntentRow key={task.id} intent={task} />
            ))}
          </div>
        );
      })}
      {abandoned.length > 0 && (
        <div className="flex flex-col">
          <button
            type="button"
            onClick={onToggleAbandoned}
            className="flex h-8 shrink-0 items-center gap-2 text-foreground-muted hover:text-foreground"
          >
            <span className="text-xs font-medium">Abandoned</span>
            <Badge variant="secondary" className="shrink-0">
              {abandoned.length}
            </Badge>
            <ChevronDown
              className={cn(
                'size-3.5 transition-transform duration-200 ease-in-out',
                showAbandoned ? 'rotate-0' : '-rotate-90'
              )}
            />
          </button>
          {showAbandoned &&
            abandoned.map((task) => <IntentRow key={task.id} intent={task} />)}
        </div>
      )}
    </div>
  );
}
