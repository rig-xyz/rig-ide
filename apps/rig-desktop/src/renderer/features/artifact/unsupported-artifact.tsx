import { ExternalLink, FileQuestion, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { relPathFromRoot } from '@shared/rig/file-navigator-categories';
import { formatFileSize } from './file-type';

/**
 * The designed empty state for a file this app has no preview for —
 * round (beyond-markdown), replacing what used to be a blanket "No
 * preview yet" toast that refused to even open the file. Centered zone,
 * hairlines only (no card-in-card), honest about what's known and what
 * isn't: filename + size/extension it CAN report, one plain sentence
 * naming the gap, then two real actions that hand the file to the OS
 * instead — `rpc.app.openPath`/`rpc.app.showItemInFolder`, both already
 * existing, already-wired RPCs (no main-process change needed for this
 * piece).
 */
export function UnsupportedArtifact({
  root,
  rootId,
  path,
  size,
}: {
  root: string;
  rootId: string;
  path: string;
  size: number | null;
}) {
  // Most callers already know the size for free (the binary sniff that
  // got this file classified as unsupported in the first place also
  // reports `size` — see `use-file-type.ts`). Only a genuinely
  // extension-only route to "unsupported" (none exists in this app's
  // detection today, but this stays correct if one ever does) falls back
  // to its own cheap read here.
  const [resolvedSize, setResolvedSize] = useState(size);
  const [sizeUnavailable, setSizeUnavailable] = useState(false);

  useEffect(() => {
    if (resolvedSize !== null) return;
    let cancelled = false;
    setSizeUnavailable(false);
    void rpc.rig.files
      .readBinary({ rootId, relativePath: relPathFromRoot(root, path), maxBytes: 0 })
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setSizeUnavailable(true);
          return;
        }
        setResolvedSize(result.data.size);
      })
      .catch(() => {
        if (!cancelled) setSizeUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [root, rootId, path, resolvedSize]);

  const filename = path.split('/').pop() ?? path;
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot + 1).toUpperCase() : null;

  const openInDefaultApp = async () => {
    const result = await rpc.app.openPath(path);
    if (!result.success) {
      toast({
        title: "Couldn't open this file",
        description: result.error,
        variant: 'destructive',
      });
    }
  };

  const revealInFinder = async () => {
    const result = await rpc.app.showItemInFolder(path);
    if (!result.success) {
      toast({
        title: "Couldn't reveal this file",
        description: result.error,
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <FileQuestion className="size-8 text-text-muted" strokeWidth={1.5} />
      <p className="max-w-sm truncate text-sm font-medium text-text-primary">{filename}</p>
      <p className="font-mono text-xs text-text-muted">
        {resolvedSize !== null
          ? formatFileSize(resolvedSize)
          : sizeUnavailable
            ? 'Size unavailable'
            : '…'}
        {extension ? ` · ${extension}` : ''}
      </p>
      <p className="text-xs text-text-muted">No preview for this file type.</p>
      <div className="flex items-center gap-4 pt-2">
        <button
          type="button"
          onClick={() => void openInDefaultApp()}
          className="flex items-center gap-1.5 text-xs text-accent transition-opacity hover:opacity-80"
        >
          <ExternalLink className="size-3.5" strokeWidth={1.5} />
          Open in default app
        </button>
        <button
          type="button"
          onClick={() => void revealInFinder()}
          className="flex items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text-primary"
        >
          <FolderOpen className="size-3.5" strokeWidth={1.5} />
          Reveal in Finder
        </button>
      </div>
    </div>
  );
}
