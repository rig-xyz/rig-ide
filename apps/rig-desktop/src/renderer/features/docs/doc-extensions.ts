import type { Extension } from '@codemirror/state';
import type { DocEditorHandle } from './doc-editor';

/**
 * Extension point for features layered on top of the doc surface
 * (comments, and later multiplayer).
 *
 * Two ways to add CM6 extensions, both read once at editor mount:
 *
 *   1. Globally, for every doc tab:
 *        const unregister = registerDocEditorExtension((ctx) => myExtension(ctx));
 *
 *   2. Per tab, by pushing onto `DocTabResource.extensionFactories` before the
 *      editor mounts.
 *
 * Factories run at mount and receive a stable context: the file path plus a
 * `getHandle()` accessor. `getHandle()` returns null while the view is being
 * constructed, and is non-null from the first CM6 callback onwards — so read it
 * lazily inside update listeners / event handlers, never at factory call time.
 */
export interface DocExtensionContext {
  /** Absolute path of the file backing this doc tab. */
  readonly path: string;
  /** The live imperative handle. Null only during view construction. */
  getHandle(): DocEditorHandle | null;
}

export type DocExtensionFactory = (ctx: DocExtensionContext) => Extension;

const globalFactories: DocExtensionFactory[] = [];

/** Registers an extension factory for every doc tab mounted from now on. */
export function registerDocEditorExtension(factory: DocExtensionFactory): () => void {
  globalFactories.push(factory);
  return () => {
    const index = globalFactories.indexOf(factory);
    if (index !== -1) globalFactories.splice(index, 1);
  };
}

/** All globally registered factories, in registration order. */
export function docEditorExtensions(): readonly DocExtensionFactory[] {
  return globalFactories;
}
