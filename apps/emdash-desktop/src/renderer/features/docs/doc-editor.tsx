import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import {
  Annotation,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { cn } from '@renderer/utils/utils';
import { DOC_FLASH_CLASS, DOC_FLASH_DURATION_MS, docTypography } from './doc-editor-theme';
import { docEditorExtensions, type DocExtensionFactory } from './doc-extensions';

/**
 * The CM6 host for the doc surface.
 *
 * The whole extensions array is assembled in one place (the mount effect below)
 * so that the multiplayer and comments layers can be slotted in without
 * restructuring: pass factories through `extraExtensions`, or register them
 * globally with `registerDocEditorExtension`.
 *
 * The view is created once per mount. Remount on a different file by keying the
 * element on the path; `initialContent` is only read at construction time.
 */

/** Viewport-relative rect, as returned by CM6's `coordsAtPos`. */
export interface DocSelectionRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface DocSelection {
  /** Document offset of the selection start. */
  from: number;
  /** Document offset of the selection end. Equal to `from` for a bare caret. */
  to: number;
  /** The selected text; empty string for a bare caret. */
  text: string;
  /** Rect spanning the selection, or null when it cannot be measured. */
  rect: DocSelectionRect | null;
}

/** Minimal imperative surface exposed to callers (and to comment/multiplayer layers). */
export interface DocEditorHandle {
  /** The live EditorView, or null when unmounted. */
  getView(): EditorView | null;
  /** Current buffer contents. */
  getContent(): string;
  /**
   * Absorb content produced outside the editor (an agent writing to disk) as a
   * minimal splice, preserving cursor, selection and scroll, and briefly
   * flashing the changed range.
   */
  applyExternal(content: string): void;
}

export interface DocEditorProps {
  /** Absolute path of the file being edited; passed through to extension factories. */
  path: string;
  /** Buffer contents at mount. Later changes are ignored — remount via `key` instead. */
  initialContent: string;
  /** Fired on every document change. `origin` distinguishes user edits from absorbed ones. */
  onChange(content: string, origin: 'local' | 'external'): void;
  /** Cmd/Ctrl+S inside the editor. */
  onSave(): void;
  /** Fired whenever the main selection changes. */
  onSelectionChange?(selection: DocSelection): void;
  /** Per-tab extension factories, applied after the globally registered ones. */
  extraExtensions?: readonly DocExtensionFactory[];
  className?: string;
}

// ── external-edit absorption ─────────────────────────────────────────────────

/** Marks transactions that came from disk rather than from the user. */
const externalOrigin = Annotation.define<boolean>();

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();
const flashMark = Decoration.mark({ class: DOC_FLASH_CLASS });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(flashEffect)) continue;
      next = effect.value
        ? Decoration.set([flashMark.range(effect.value.from, effect.value.to)])
        : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Reduce two document versions to the single changed middle region by trimming
 * the common prefix and suffix. Returns null when the texts are identical.
 *
 * Offsets are in `oldText` coordinates; `insert` is the replacement text.
 */
export function computeSplice(
  oldText: string,
  newText: string
): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null;

  const shortest = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < shortest && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  return { from: start, to: oldEnd, insert: newText.slice(start, newEnd) };
}

// ── component ────────────────────────────────────────────────────────────────

function selectionOf(view: EditorView): DocSelection {
  const { from, to } = view.state.selection.main;
  let rect: DocSelectionRect | null = null;
  const head = view.coordsAtPos(from);
  const tail = from === to ? head : view.coordsAtPos(to);
  if (head && tail) {
    rect = {
      top: Math.min(head.top, tail.top),
      bottom: Math.max(head.bottom, tail.bottom),
      left: Math.min(head.left, tail.left),
      right: Math.max(head.right, tail.right),
    };
  }
  return { from, to, text: view.state.sliceDoc(from, to), rect };
}

export const DocEditor = forwardRef<DocEditorHandle, DocEditorProps>(function DocEditor(
  { path, initialContent, onChange, onSave, onSelectionChange, extraExtensions, className },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  // Callbacks are read through a ref so the view is constructed exactly once.
  const callbacksRef = useRef({ onChange, onSave, onSelectionChange });
  useEffect(() => {
    callbacksRef.current = { onChange, onSave, onSelectionChange };
  }, [onChange, onSave, onSelectionChange]);

  const handle = useMemo<DocEditorHandle>(
    () => ({
      getView: () => viewRef.current,
      getContent: () => viewRef.current?.state.doc.toString() ?? '',
      applyExternal: (content: string) => {
        const view = viewRef.current;
        if (!view) return;
        const splice = computeSplice(view.state.doc.toString(), content);
        if (!splice) return;

        const flashTo = splice.from + splice.insert.length;
        view.dispatch({
          changes: splice,
          annotations: externalOrigin.of(true),
          // Zero-length mark decorations are rejected by CM6, so pure deletions
          // land without a flash.
          effects:
            splice.insert.length > 0 ? flashEffect.of({ from: splice.from, to: flashTo }) : [],
        });

        if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = window.setTimeout(() => {
          flashTimerRef.current = null;
          viewRef.current?.dispatch({ effects: flashEffect.of(null) });
        }, DOC_FLASH_DURATION_MS);
      },
    }),
    []
  );

  useImperativeHandle(ref, () => handle, [handle]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const extensionContext = {
      path,
      getHandle: () => (viewRef.current ? handle : null),
    };

    const extensions: Extension[] = [
      // Language + writing-surface behavior. No line numbers, no gutters.
      markdown(),
      EditorView.lineWrapping,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      // Ahead of the default keymap, and preventDefault so the browser's own
      // save never fires. The task pane's window-level Cmd+S handler already
      // bails for doc tabs (it only resolves paths for 'file' tabs).
      Prec.high(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              callbacksRef.current.onSave();
              return true;
            },
          },
        ])
      ),
      docTypography,
      flashField,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const isExternal = update.transactions.some((tr) => tr.annotation(externalOrigin));
          callbacksRef.current.onChange(
            update.state.doc.toString(),
            isExternal ? 'external' : 'local'
          );
        }
        if (update.selectionSet || update.docChanged) {
          callbacksRef.current.onSelectionChange?.(selectionOf(update.view));
        }
      }),
      ...docEditorExtensions().map((factory) => factory(extensionContext)),
      ...(extraExtensions ?? []).map((factory) => factory(extensionContext)),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: initialContent, extensions }),
      parent: host,
    });
    viewRef.current = view;

    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
      viewRef.current = null;
      view.destroy();
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  return <div ref={hostRef} className={cn('h-full w-full overflow-hidden', className)} />;
});
