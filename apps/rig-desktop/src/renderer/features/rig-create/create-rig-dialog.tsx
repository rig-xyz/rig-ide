import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, FileInput, FolderCheck, FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { ImportDocField } from '@renderer/features/rig-import/import-doc-field';
import {
  deriveImportSource,
  EMPTY_IMPORT_SOURCE,
  type ImportSourceInput,
} from '@renderer/features/rig-import/import-source';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { cn } from '@renderer/lib/utils';
import type { RigCreateResult } from '@shared/rig/create';
import { deriveCreateFormState } from './create-form-state';

/**
 * Home's "New rig" dialog: name (slug preview when the CLI's naming rule
 * would change it), a parent folder via the native picker, and a real
 * sync toggle — `rig sync` is the CLI's genuine go-live verb, so the toggle
 * is honest end-to-end. Drives `rig.create.create` (main spawns the bundled
 * CLI headlessly) and, when the new rig came up SYNCED, opens it through
 * the normal `openPath` flow.
 *
 * A local-only outcome (toggle off, or sync failed after creation) does NOT
 * open: this app's rig view only opens bound workspaces
 * (`workspace.detect` requires a relay binding), so the dialog shows the
 * created path and says exactly that instead of navigating into a
 * "not a rig" dead end.
 */
export function CreateRigDialog({
  open,
  onOpenChange,
  onOpenPath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenPath: (path: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <DialogTitle>New rig</DialogTitle>
          <DialogClose />
        </div>
        {/* Keyed remount per open so a reopened dialog never carries stale
            fields or a leftover created-state. */}
        {open && <CreateRigForm onOpenPath={onOpenPath} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function CreateRigForm({
  onOpenPath,
  onClose,
}: {
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [sync, setSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdLocal, setCreatedLocal] = useState<RigCreateResult | null>(null);
  const [lateSyncBusy, setLateSyncBusy] = useState(false);
  const [lateSyncError, setLateSyncError] = useState<string | null>(null);
  const [importValue, setImportValue] = useState<ImportSourceInput>(EMPTY_IMPORT_SOURCE);
  const importState = deriveImportSource(importValue);

  // A4 fix — this form unmounts the instant the dialog closes (the parent's
  // `{open && <CreateRigForm />}`), but `create`/`turnOnSyncLate`'s own
  // in-flight main-process work (unabortable — a real `rig init`/`sync`
  // spawn) keeps running regardless. Without this, a completion landing
  // AFTER the user explicitly closed the dialog still called `onOpenPath`,
  // silently navigating them into a rig they'd just dismissed. A plain
  // `useRef` survives in the async closures even after unmount (the
  // object itself, not the component, is what they hold onto) — flipped
  // by this cleanup effect, which only ever runs on unmount.
  const closedRef = useRef(false);
  useEffect(() => {
    return () => {
      closedRef.current = true;
    };
  }, []);

  /** The outcome zone's [Turn on sync] — same driver creation itself uses. */
  const turnOnSyncLate = async () => {
    if (!createdLocal) return;
    setLateSyncBusy(true);
    setLateSyncError(null);
    const result = await rpc.rig.create.enableSync({ dir: createdLocal.path });
    if (closedRef.current) {
      // The write already happened (or failed) server-side — say so
      // quietly rather than navigating into a dialog the user closed.
      if (result.success) toast({ title: `Synced “${createdLocal.rigName}”` });
      return;
    }
    setLateSyncBusy(false);
    if (!result.success) {
      setLateSyncError(result.error.message);
      return;
    }
    onClose();
    onOpenPath(createdLocal.path);
  };

  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = authQuery.data?.signedIn ?? false;
  const { signIn, phase: signInPhase } = useRigSignIn(() => {
    void queryClient.invalidateQueries({ queryKey: ['rig', 'auth', 'status'] });
  });

  const form = deriveCreateFormState({ name, parentDir, sync, signedIn, busy });

  const chooseFolder = async () => {
    try {
      const picked = await rpc.app.openSelectDirectoryDialog({
        title: 'Where should the rig live?',
        message: 'The rig is created as a new folder inside your choice',
        // Picker-latency round: lets main attribute click→panel time
        // (IPC/main-loop queueing vs the OS panel itself) in its log.
        requestedAt: Date.now(),
      });
      if (picked) setParentDir(picked);
    } catch (pickError) {
      toast({
        title: "Couldn't open the folder picker",
        description: pickError instanceof Error ? pickError.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await rpc.rig.create.create({
      parentDir: parentDir!,
      name,
      sync: form.syncEffective,
    });
    if (!result.success) {
      // Closed mid-flight: nothing left to show an error IN (the dialog's
      // gone) and nothing to retry from here — drop it silently, per the
      // guard's own purpose (not yanking the user, not pestering them
      // either).
      if (!closedRef.current) {
        setBusy(false);
        setError(result.error.message);
      }
      return;
    }

    // Optional doc import, INTO the just-created rig, before it opens.
    // Creation never rolls back for an import failure — that outcome is an
    // honest partial: the rig opens, the toast names exactly what failed.
    if (importState.source) {
      if (!closedRef.current) setImporting(true);
      const imported = await rpc.rig.importDoc.importDoc({
        root: result.data.path,
        source: importState.source,
      });
      if (!closedRef.current) setImporting(false);
      if (!imported.success) {
        toast({
          title: 'Created the rig, but the doc import failed',
          description: imported.error.message,
          variant: 'destructive',
        });
      }
    }
    if (!closedRef.current) setBusy(false);

    void queryClient.invalidateQueries({ queryKey: ['rig', 'recent'] });
    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });

    // A4 fix: the dialog may have been closed while create/import (both
    // unabortable, main-side work) were still running. The rig genuinely
    // got created either way — say so quietly instead of navigating the
    // user into something they explicitly dismissed away from.
    if (closedRef.current) {
      toast({ title: `Created “${result.data.rigName}”` });
      return;
    }

    if (result.data.synced) {
      // Bound and live — the normal open flow takes it from here.
      onClose();
      onOpenPath(result.data.path);
      return;
    }
    // Created but not synced (by choice, or sync failed): the rig view only
    // opens bound workspaces, so stay here and say what exists where.
    setCreatedLocal(result.data);
  };

  if (createdLocal) {
    // A proper outcome zone (design round): the fact first — icon + name,
    // path as mono metadata — then the local-only explanation as its own
    // distinctly quieter block (bg-2 fill, no border: it's context, not a
    // card with zones). Loose-ends round: [Turn on sync] is a REAL action
    // here (the same `rig sync` driver creation itself uses), with the CLI
    // command kept as mono subtext for transparency.
    return (
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex items-center gap-2">
          <FolderCheck className="text-text-secondary size-4 shrink-0" strokeWidth={1.5} />
          <p className="text-text-primary text-sm font-medium">Created “{createdLocal.rigName}”</p>
        </div>
        <p className="text-text-muted font-mono text-xs break-all">{createdLocal.path}</p>
        <div className="bg-bg-2 rounded-control flex flex-col gap-1 px-3 py-2">
          {createdLocal.syncError && (
            <p className="text-text-secondary text-xs">
              Sync didn’t come on: {createdLocal.syncError.message}
            </p>
          )}
          <p className="text-text-muted text-xs">
            It’s local-only for now. Syncing turns on sharing, invites, and lets this app open
            it.
          </p>
          <p className="text-text-muted font-mono text-xs">equivalent: rig sync</p>
        </div>
        {lateSyncError && <p className="text-danger text-xs">{lateSyncError}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={lateSyncBusy}>
            Done
          </Button>
          <Button size="sm" onClick={() => void turnOnSyncLate()} disabled={lateSyncBusy}>
            {lateSyncBusy ? 'Turning on…' : 'Turn on sync'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    // Design round: the dialog reads top-to-bottom as the flow itself —
    // what it's called → where it lives → does it sync → optionally seed
    // it. The name/location pair is the borderless primary zone; SYNC and
    // the doc seed are the two zones that EARN a card (Rule 3): each has
    // real internal structure (icon + label + helper + control; header +
    // tiles + affordance). Icons only where they carry structure (Rule 2),
    // mono strictly for slug/path metadata, 12px between zones / 8px inside
    // cards / 4px inside field groups. Enter submits when valid; Escape is
    // the primitive's dismiss; primary action bottom-right.
    <div
      className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.metaKey || event.shiftKey) return;
        if (event.target instanceof HTMLElement && event.target.closest('button')) return;
        if (form.canSubmit && !importState.urlError) void create();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="rig-name" className="text-text-secondary text-xs font-medium">
          Name
        </label>
        <input
          id="rig-name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="team-roadmap"
          // D2 fix: `outline-none` alone also suppressed the global
          // `:focus-visible` ring (Tailwind's utilities layer beats
          // `@layer base`) — re-added via `focus-visible:` utilities,
          // consistent with how buttons already do it elsewhere.
          className="border-border-hairline bg-bg-1 text-text-primary placeholder:text-text-muted focus:border-border-strong focus-visible:outline-accent rounded-control border px-2 py-1.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
        />
        {form.nameError ? (
          <p className="text-danger text-xs">{form.nameError}</p>
        ) : form.showSlugPreview ? (
          <p className="text-text-muted font-mono text-xs">{form.slug}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-text-secondary text-xs font-medium">Location</span>
        {parentDir ? (
          // The chosen destination as a quiet path row: folder glyph, the
          // full mono path (parent + slug), Change… as a text affordance.
          <div className="border-border-hairline flex min-w-0 items-center gap-2 rounded-control border px-2 py-1.5">
            <FolderOpen className="text-text-muted size-3.5 shrink-0" strokeWidth={1.5} />
            <span className="text-text-secondary min-w-0 flex-1 truncate font-mono text-xs" title={parentDir}>
              {parentDir}
              {form.slug ? `/${form.slug}` : ''}
            </span>
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="text-text-muted hover:text-text-primary shrink-0 text-xs transition-colors"
            >
              Change…
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void chooseFolder()}
            className="border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex items-center gap-1.5 self-start border bg-transparent px-2 py-1 text-xs transition-colors"
          >
            <FolderOpen className="size-3.5" strokeWidth={1.5} />
            Choose folder…
          </button>
        )}
      </div>

      {/* SYNC as a real choice, not a bare toggle line: a card row with the
          icon naming what it is, the helper naming what it buys, and the
          switch as its one control. */}
      <div className="border-border-hairline rounded-card flex flex-col gap-2 border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <Cloud className="text-text-muted mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor="rig-sync" className="text-text-primary text-xs font-medium">
                Sync to your workspace
              </label>
              <p className="text-text-muted text-xs">Syncing enables sharing and invites.</p>
            </div>
          </div>
          <button
            id="rig-sync"
            type="button"
            role="switch"
            aria-checked={sync}
            aria-label="Sync to your workspace"
            onClick={() => setSync((v) => !v)}
            className={cn(
              // D4 fix: a neutral fill on ("border-strong" — the same token
              // `SourceTile`'s own active state uses), not accent — the
              // accent budget stays reserved for genuinely primary actions,
              // not every toggle that happens to be on.
              'relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors',
              sync ? 'bg-border-strong' : 'bg-bg-2 border-border-hairline border'
            )}
          >
            <span
              className={cn(
                'bg-bg-1 absolute top-0.5 left-0.5 size-3 rounded-full transition-transform',
                sync && 'translate-x-3'
              )}
            />
          </button>
        </div>
        {form.syncNeedsSignIn && (
          <div className="flex items-center justify-between gap-2 pl-6">
            <p className="text-text-muted min-w-0 text-xs">
              Sign in to sync, or it’s created local-only.
            </p>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void signIn()}
              disabled={signInPhase !== 'idle'}
            >
              {signInPhase === 'idle' ? 'Sign in' : 'Waiting…'}
            </Button>
          </div>
        )}
      </div>

      {/* The optional seed as an earned card: header (icon + section-language
          label + 'optional' mono chip), then the two source tiles. Import
          runs AFTER init/sync, into the new folder. Comments/suggestions
          never survive any Google Docs export — the copy stays silent about
          them rather than implying otherwise. */}
      <div className="border-border-hairline rounded-card flex flex-col gap-2 border p-3">
        <div className="flex items-center gap-2">
          <FileInput className="text-text-muted size-3.5 shrink-0" strokeWidth={1.5} />
          <span className="text-text-muted font-mono text-xs tracking-wide uppercase">
            Start from a Google Doc
          </span>
          <span className="bg-bg-2 text-text-muted rounded-chip px-1.5 py-0.5 font-mono text-xs">
            optional
          </span>
        </div>
        <ImportDocField
          value={importValue}
          state={importState}
          disabled={busy}
          onChange={setImportValue}
        />
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex justify-end pt-1">
        <Button
          size="sm"
          onClick={() => void create()}
          disabled={!form.canSubmit || importState.urlError !== null}
        >
          {importing ? 'Importing…' : busy ? 'Creating…' : 'Create rig'}
        </Button>
      </div>
    </div>
  );
}
