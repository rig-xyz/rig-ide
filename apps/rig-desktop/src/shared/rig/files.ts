/**
 * Filesystem surface for a bound rig workspace, keyed on absolute paths rather
 * than the emdash project/workspace registry (there is no "task" behind a
 * plain `File → Open Folder…`, and registering one just to read a directory
 * would drag in worktree provisioning this app doesn't need).
 *
 * `read`/`write` mirror the shape `workspace.files` returns so `doc-file-sync.ts`
 * ports with only its IO layer swapped. `watch`/`unwatch` back a coarse "something
 * under this root changed" signal — `rigFileChangeChannel` — which is all the
 * doc-file-sync absorb path needs: it always re-reads its own file to decide
 * whether anything actually changed.
 */

import { defineEvent } from '../lib/ipc/events';

export type RigFileNodeKind = 'file' | 'dir';

export type RigFileNode = {
  name: string;
  /** Path relative to the listed root, forward slashes. */
  relPath: string;
  kind: RigFileNodeKind;
  /** Present only for `kind: 'dir'`, sorted directories-first then alphabetically. */
  children?: RigFileNode[];
};

export type RigFileListError = { kind: 'notFound' | 'notADirectory' | 'ioError'; message: string };
export type RigFileReadError = { kind: 'notFound' | 'tooLarge' | 'ioError'; message: string };
export type RigFileWriteError = { kind: 'ioError'; message: string };

export type RigFileReadResult = { content: string; truncated: boolean };

/**
 * Round (beyond-markdown): the binary counterpart to `read` — for anything
 * `read`'s `utf8` decode would corrupt (images) or that needs raw bytes
 * rather than best-effort text (the binary sniff for an unrecognized
 * extension, `file-type.ts`'s `looksBinary`). `data` is base64 (IPC only
 * carries JSON-serializable values); `size` is the file's REAL total size
 * from `stat`, independent of `maxBytes` — the one call the image viewer's
 * metadata line and the unsupported-file view's size line both read off
 * without a second round-trip.
 */
export type RigFileReadBinaryResult = { data: string; truncated: boolean; size: number };

/** Something changed somewhere under `root` — the receiver re-reads to find out what. */
export type RigFileChangeUpdate = { root: string };

export const rigFileChangeChannel = defineEvent<RigFileChangeUpdate>('rig:file-change');
