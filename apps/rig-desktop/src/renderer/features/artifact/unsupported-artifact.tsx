import { ExternalLink, FileQuestion, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
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
export function UnsupportedArtifact({ path, size }: { path: string; size: number | null }) {
  // Most callers already know the size for free (the binary sniff that
  // got this file classified as unsupported in the first place also
  // reports `size` — see `use-file-type.ts`). Only a genuinely
  // extension-only route to "unsupported" (none exists in this app's
  // detection today, but this stays correct if one ever does) falls back
  // to its own cheap read here.
  const [resolvedSize, setResolvedSize] = useState(size);

  useEffect(() => {
    if (resolvedSize !== null) return;
    let cancelled = false;
    void rpc.rig.files.readBinary(path, 0).then((result) => {
      if (cancelled || !result.success) return;
      setResolvedSize(result.data.size);
    });
    return () => {
      cancelled = true;
    };
  }, [path, resolvedSize]);

  const filename = path.split('/').pop() ?? path;
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot + 1).toUpperCase() : null;

  const openInDefaultApp = async () => {
    const result = await rpc.app.openPath(path);
    if (!result.success) {
      toast({ title: "Couldn't open this file", description: result.error, variant: 'destructive' });
    }
  };

  const revealInFinder = async () => {
    const result = await rpc.app.showItemInFolder(path);
    if (!result.success) {
      toast({ title: "Couldn't reveal this file", description: result.error, variant: 'destructive' });
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <FileQuestion className="text-text-muted size-8" strokeWidth={1.5} />
      <p className="text-text-primary max-w-sm truncate text-sm font-medium">{filename}</p>
      <p className="text-text-muted font-mono text-xs">
        {resolvedSize !== null ? formatFileSize(resolvedSize) : '…'}
        {extension ? ` · ${extension}` : ''}
      </p>
      <p className="text-text-muted text-xs">No preview for this file type.</p>
      <div className="flex items-center gap-4 pt-2">
        <button
          type="button"
          onClick={() => void openInDefaultApp()}
          className="text-accent flex items-center gap-1.5 text-xs transition-opacity hover:opacity-80"
        >
          <ExternalLink className="size-3.5" strokeWidth={1.5} />
          Open in default app
        </button>
        <button
          type="button"
          onClick={() => void revealInFinder()}
          className="text-text-muted hover:text-text-primary flex items-center gap-1.5 text-xs transition-colors"
        >
          <FolderOpen className="size-3.5" strokeWidth={1.5} />
          Reveal in Finder
        </button>
      </div>
    </div>
  );
}
