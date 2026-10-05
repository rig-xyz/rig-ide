/**
 * A file or folder moved: renamed to `to`, or archived out of view
 * (`to: null`). Absolute paths. Every rename (`RenameFileDialog`) and
 * archive (`archiveEntry`) announces itself once the move landed, so open
 * tabs can follow (`App.tsx`) whichever menu started it.
 */
export type FileMove = { from: string; to: string | null };

const moveListeners = new Set<(move: FileMove) => void>();

export function announceFileMove(move: FileMove): void {
  for (const listener of moveListeners) listener(move);
}

export function onFileMove(listener: (move: FileMove) => void): () => void {
  moveListeners.add(listener);
  return () => {
    moveListeners.delete(listener);
  };
}
