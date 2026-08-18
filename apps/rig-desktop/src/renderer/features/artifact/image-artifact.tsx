import { ImageOff, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { formatFileSize } from './file-type';

/**
 * A quiet, read-only image viewer — round (beyond-markdown). No "Saved"
 * chrome at all (the header omits it entirely for this category — see
 * `artifact-view.tsx`): there is nothing to save.
 *
 * SVG goes through this exact same path as any raster image — an `<img
 * src="data:image/svg+xml;base64,…">`, never inline DOM
 * (`dangerouslySetInnerHTML`/an `<object>`/`<embed>`). That's the actual
 * script-safety boundary: an `<img>` tag renders SVG in a restricted mode
 * that never executes embedded `<script>` elements or event-handler
 * attributes, unlike inlining its markup into the page's own DOM would.
 * "SVG is text" is true but irrelevant here — it's rendered as a picture,
 * not edited as one.
 *
 * Capped at `MAX_IMAGE_BYTES` — an image bigger than that shows an honest
 * "too large to preview" message instead of a corrupt, truncated render
 * (unlike a text file, a partial image isn't a useful degraded view of a
 * real one).
 */

const MAX_IMAGE_BYTES = 20 * 1000 * 1000; // 20 MB — generous; a genuinely enormous image gets the honest "too large" state instead.

type LoadState =
  | { kind: 'loading' }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; src: string; size: number };

export function ImageArtifact({ path, mime }: { path: string; mime: string }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.rig.files.readBinary(path, MAX_IMAGE_BYTES).then((result) => {
      if (cancelled) return;
      if (!result.success) {
        setState({ kind: 'error', message: result.error.message });
        return;
      }
      if (result.data.truncated) {
        setState({ kind: 'tooLarge', size: result.data.size });
        return;
      }
      setState({ kind: 'ready', src: `data:${mime};base64,${result.data.data}`, size: result.data.size });
    });
    return () => {
      cancelled = true;
    };
    // `path`/`mime` alone: the caller remounts this component on file
    // change, same convention as `use-file-type.ts`'s own effect.
  }, [path, mime]);

  const extension = path.split('.').pop()?.toUpperCase() ?? '';

  if (state.kind === 'loading') {
    return (
      <div className="text-text-muted flex h-full items-center justify-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
        Loading…
      </div>
    );
  }

  if (state.kind === 'error' || state.kind === 'tooLarge') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <ImageOff className="text-text-muted size-8" strokeWidth={1.5} />
        <p className="text-text-secondary text-sm">
          {state.kind === 'tooLarge'
            ? `Image too large to preview (${formatFileSize(state.size)}).`
            : `Could not open this image: ${state.message}`}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
      <div className="bg-bg-2 rounded-card flex max-h-full max-w-full items-center justify-center overflow-hidden p-4">
        {/* alt="" — decorative content view; the filename is already in the header breadcrumb. */}
        <img
          src={state.src}
          alt=""
          className="max-h-[70vh] max-w-full object-contain"
          onLoad={(event) => {
            const img = event.currentTarget;
            setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
          }}
        />
      </div>
      <p className="text-text-muted font-mono text-xs">
        {dimensions ? `${dimensions.width} × ${dimensions.height} px · ` : ''}
        {formatFileSize(state.size)}
        {extension ? ` · ${extension}` : ''}
      </p>
    </div>
  );
}
