/**
 * Ask the app to open a file in a tab, from a surface that isn't handed an
 * `onOpenFile` (the shared file actions menu, a doc's own banner).
 * `App.tsx` listens and opens it the way any other open does. Absolute path.
 */

const listeners = new Set<(absPath: string) => void>();

export function requestOpenFile(absPath: string): void {
  for (const listener of listeners) listener(absPath);
}

export function onOpenFileRequest(listener: (absPath: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
