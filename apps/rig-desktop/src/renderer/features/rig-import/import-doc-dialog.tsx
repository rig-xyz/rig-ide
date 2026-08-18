import { useEffect, useRef, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { cn } from '@renderer/lib/utils';
import {
  rigImportProgressChannel,
  type RigImportPhase,
  type RigImportProgress,
} from '@shared/rig/import-doc';
import { ImportDocField } from './import-doc-field';
import {
  deriveImportSource,
  EMPTY_IMPORT_SOURCE,
  importWorkingLabel,
  type ImportSourceInput,
} from './import-source';

/**
 * The open-rig Import action's dialog: paste a Google Docs link (or choose
 * a .docx) → `rig.importDoc.importDoc` writes `<slug>.md` (+ any images
 * under `assets/<slug>/`) into the rig's root, and the caller opens it in
 * the artifact view. Fidelity copy is honest: comments and suggestions do
 * not survive ANY Google Docs export — never implied otherwise.
 */
export function ImportDocDialog({
  root,
  open,
  onOpenChange,
  onImported,
}: {
  root: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (mdPath: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <DialogTitle>Import a doc</DialogTitle>
          <DialogClose />
        </div>
        {/* Keyed remount per open — a reopened dialog never carries stale fields. */}
        {open && (
          <ImportDocForm
            root={root}
            onDone={(mdPath) => {
              onOpenChange(false);
              onImported(mdPath);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const IMPORT_PHASES: readonly RigImportPhase[] = ['fetching', 'converting', 'writing'];

function ImportDocForm({ root, onDone }: { root: string; onDone: (mdPath: string) => void }) {
  const [value, setValue] = useState<ImportSourceInput>(EMPTY_IMPORT_SOURCE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<RigImportProgress | null>(null);
  const state = deriveImportSource(value);

  // A4 fix — this form unmounts the instant the dialog closes (the
  // parent's `{open && <ImportDocForm />}`), but `runImport`'s in-flight
  // main-process work (unabortable — fetch/convert/write) keeps running
  // regardless. Without this, a completion landing AFTER the user
  // explicitly closed the dialog still called `onDone` → `onImported`,
  // silently navigating them into a doc they'd just dismissed away from.
  // Survives unmount because the async closure holds the SAME mutable
  // ref object this cleanup effect flips, not a snapshot of the component.
  const closedRef = useRef(false);
  useEffect(() => {
    return () => {
      closedRef.current = true;
    };
  }, []);

  // Main pushes phase transitions (and the doc title the moment the export
  // response yields it) on `rigImportProgressChannel` — subscribed only
  // while this dialog is actually working, per the channel's contract.
  useEffect(() => {
    if (!busy) return;
    return events.on(rigImportProgressChannel, setProgress);
  }, [busy]);

  const runImport = async () => {
    if (!state.source) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    const result = await rpc.rig.importDoc.importDoc({ root, source: state.source });
    if (closedRef.current) {
      // The write already happened (or failed) server-side — say so
      // quietly rather than navigating into a dialog the user closed.
      if (result.success) toast({ title: 'Doc imported' });
      return;
    }
    setBusy(false);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    onDone(result.data.mdPath);
  };

  if (busy) {
    // Working state, not a bare spinner: the REAL doc title the moment
    // main's progress event carries it (the export response's
    // Content-Disposition on the URL path; the file's own name from the
    // start), the honest generic until then — with the pipeline phases as
    // quiet mono subtext, the current one carried slightly forward.
    const activePhase = progress?.phase ?? 'fetching';
    return (
      <div className="flex flex-col gap-1.5 px-4 pb-4">
        <div className="flex items-center gap-2">
          <span className="bg-accent size-1.5 shrink-0 animate-pulse rounded-full" />
          <p className="text-text-primary text-sm">
            Importing {progress?.title ?? importWorkingLabel(value)}…
          </p>
        </div>
        <p className="text-text-muted pl-3.5 font-mono text-xs">
          {IMPORT_PHASES.map((phase, index) => (
            <span key={phase}>
              {index > 0 && ' · '}
              <span className={cn(phase === activePhase && 'text-text-secondary')}>{phase}</span>
            </span>
          ))}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 px-4 pb-4"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.metaKey || event.shiftKey) return;
        if (event.target instanceof HTMLElement && event.target.closest('button')) return;
        if (state.source && !busy) void runImport();
      }}
    >
      <ImportDocField value={value} state={state} disabled={busy} onChange={setValue} />
      <p className="text-text-muted text-xs">
        Text, headings, lists, tables, links and images come across. Comments and suggestions
        don&rsquo;t survive export.
      </p>
      {error && <p className="text-danger text-xs">{error}</p>}
      <div className="flex justify-end pt-1">
        <Button size="sm" onClick={() => void runImport()} disabled={!state.source}>
          Import
        </Button>
      </div>
    </div>
  );
}
