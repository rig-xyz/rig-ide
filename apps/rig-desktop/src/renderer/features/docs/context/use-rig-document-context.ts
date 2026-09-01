import { useEffect, useRef } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { buildAnchorFromRange } from '../comments/anchors';
import type { DocSelection } from '../doc-editor';
import type { DocTabResource } from '../doc-file-sync';
import type { PositionIndex } from '../preview/position-index';
import { RigDocumentContextController } from './active-document-context';

function applySelection(
  controller: RigDocumentContextController,
  content: string,
  selection: Pick<DocSelection, 'from' | 'to' | 'text'>
): void {
  if (selection.from === selection.to || selection.text.trim().length === 0) {
    controller.setSelection(null);
    return;
  }
  controller.setSelection(buildAnchorFromRange(content, selection.from, selection.to));
}

/** Capture Edit- or Preview-mode passage state for the next Rig chat prompt. */
export function useRigDocumentContext({
  root,
  rootId,
  resource,
  mode,
  getPreviewRoot,
  getPreviewIndex,
}: {
  root: string;
  rootId: string;
  resource: DocTabResource;
  mode: 'edit' | 'preview';
  getPreviewRoot: () => HTMLElement | null;
  getPreviewIndex: () => PositionIndex | null;
}): void {
  const controllerRef = useRef<RigDocumentContextController | null>(null);
  const previewRootRef = useRef(getPreviewRoot);
  const previewIndexRef = useRef(getPreviewIndex);
  previewRootRef.current = getPreviewRoot;
  previewIndexRef.current = getPreviewIndex;

  useEffect(() => {
    const controller = new RigDocumentContextController(
      { root, rootId, relativePath: resource.relativePath },
      (input) => rpc.rig.context.createTarget(input),
      undefined,
      (error) => {
        const kind =
          typeof error === 'object' && error !== null && 'kind' in error
            ? String((error as { kind: unknown }).kind)
            : 'transport';
        console.warn('Rig document context unavailable', { kind });
      }
    );
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, [resource, root, rootId]);

  useEffect(() => {
    // Switching renderers destroys the browser/editor selection. Do not let
    // the passage from the previous surface become ambient context for the
    // next prompt.
    controllerRef.current?.setSelection(null);
  }, [mode, resource]);

  useEffect(() => {
    if (mode !== 'edit') return;
    return resource.subscribeSelection((selection) => {
      const controller = controllerRef.current;
      if (controller) applySelection(controller, resource.content, selection);
    });
  }, [mode, resource]);

  useEffect(() => {
    if (mode !== 'preview') return;
    const capture = () => {
      const controller = controllerRef.current;
      const rootElement = previewRootRef.current();
      const selection = window.getSelection();
      if (!controller || !rootElement || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!rootElement.contains(range.commonAncestorContainer)) return;
      if (selection.isCollapsed || !selection.toString().trim()) {
        controller.setSelection(null);
        return;
      }
      const mapped = previewIndexRef.current()?.rangeToSource(range);
      if (!mapped) {
        controller.setSelection(null);
        return;
      }
      applySelection(controller, resource.content, {
        from: mapped.start,
        to: mapped.end,
        text: resource.content.slice(mapped.start, mapped.end),
      });
    };
    document.addEventListener('mouseup', capture);
    document.addEventListener('keyup', capture);
    return () => {
      document.removeEventListener('mouseup', capture);
      document.removeEventListener('keyup', capture);
    };
  }, [mode, resource]);
}
