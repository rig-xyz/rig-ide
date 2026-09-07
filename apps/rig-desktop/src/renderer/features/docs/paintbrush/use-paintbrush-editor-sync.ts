import { useEffect } from 'react';
import type { DocTabResource } from '../doc-file-sync';
import {
  setPaintbrushArmed,
  setPaintbrushOverlay,
  type PaintbrushOverlay,
} from './paintbrush-decorations';

/**
 * Pushes paintbrush mode/overlay state into the mounted CM6 view — the
 * Edit-mode half of the wiring (`paintbrush-decorations.ts`'s extension is
 * dumb by design: it paints whatever it's handed, same as
 * `comment-decorations.ts`'s `setCommentMarkers`). A no-op while Preview is
 * showing — there is no view to dispatch to; `use-paintbrush-preview-overlay.ts`
 * is Preview's own counterpart.
 */
export function usePaintbrushEditorSync(
  resource: DocTabResource,
  mode: 'preview' | 'edit',
  armed: boolean,
  overlay: PaintbrushOverlay | null
): void {
  useEffect(() => {
    if (mode !== 'edit') return;
    resource.editorRef.current?.getView()?.dispatch({ effects: setPaintbrushArmed.of(armed) });
  }, [resource, mode, armed]);

  // `overlay` is a fresh object literal every render (`DocCommentsStore
  // .paintbrushOverlay`'s own doc comment — a plain getter, not `computed`)
  // — depend on its primitive fields instead of its identity, so this
  // dispatches only when the actual range/streaming state changes rather
  // than on every unrelated re-render of the artifact pane.
  useEffect(() => {
    if (mode !== 'edit') return;
    resource.editorRef.current
      ?.getView()
      ?.dispatch({ effects: setPaintbrushOverlay.of(overlay ? [overlay] : []) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, mode, overlay?.from, overlay?.to, overlay?.streaming]);
}
