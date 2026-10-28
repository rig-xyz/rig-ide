import { reaction } from 'mobx';
import { useSyncExternalStore } from 'react';
import type { RigChatStore } from '@renderer/features/chat/rig-chat-store';
import type { RigSessionStart } from '@shared/rig/feed';

/**
 * Rig reporting in Home's chat on the work it started for the person: a
 * note when a session starts from a card ("Started working on …"), and
 * another when it waits on them or is done ("… is ready for review",
 * "Done: …"), each with an Open to the session in its space. The sessions
 * live in the window (`rig-session-registry.ts`), so this follows their own
 * state, the same signals the rail shows, and never polls. Notes are kept
 * for the window's life, as Home's chat is.
 */

export type HomeNote = {
  id: string;
  at: number;
  kind: 'started' | 'review' | 'done';
  /** The work's title, as its card named it. */
  title: string;
  /** The session, to open in its space. */
  root: string;
  sessionId: string;
};

/** What a note says, around its title (the Open is its own button). */
export function noteWords(note: Pick<HomeNote, 'kind'>): { before: string; after: string } {
  switch (note.kind) {
    case 'started':
      return { before: 'Started working on ', after: ". I'll let you know when it's done." };
    case 'review':
      return { before: '', after: ' is ready for review.' };
    case 'done':
      return { before: 'Done: ', after: '.' };
  }
}

let notes: readonly HomeNote[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function post(note: Omit<HomeNote, 'id' | 'at'>, now = Date.now()): void {
  notes = [...notes, { ...note, id: `note:${++seq}`, at: now }];
  for (const listener of listeners) listener();
}

/** Home's notes, oldest first. */
export function homeNotes(): readonly HomeNote[] {
  return notes;
}

/** Home's notes, live. */
export function useHomeNotes(): readonly HomeNote[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    homeNotes,
    homeNotes
  );
}

/** For tests: start again with none. */
export function resetHomeNotes(): void {
  notes = [];
  for (const listener of listeners) listener();
}

/** Where a session stands, as the note follows it. */
type Phase = 'working' | 'needs_you' | 'idle';

function phaseOf(store: RigChatStore): Phase {
  if (store.permissionQueue.length > 0) return 'needs_you';
  return store.affordances.isWorking ? 'working' : 'idle';
}

/** Sessions being followed, so a second start of the same one doesn't double its notes. */
const following = new Map<string, () => void>();

/**
 * Rig started a session for the person: say so in Home, then follow it.
 * When it stops to ask them, or ends a turn that drafts and asks first (a
 * card's Reply), it's ready for their review; when it ends otherwise, it's
 * done. Each is said once per time it happens.
 */
export function noteSessionStart(start: RigSessionStart, store: RigChatStore): void {
  const where = { title: start.title, root: start.root, sessionId: store.conversationId };
  post({ kind: 'started', ...where });
  following.get(store.conversationId)?.();
  let worked = false;
  const stop = reaction(
    () => (store.disposed ? 'idle' : phaseOf(store)),
    (phase, was) => {
      if (phase === 'working') worked = true;
      if (phase === 'needs_you' && was !== 'needs_you') post({ kind: 'review', ...where });
      if (phase === 'idle' && worked && was === 'working') {
        post({ kind: start.askFirst ? 'review' : 'done', ...where });
        worked = false;
        if (!start.askFirst) end();
      }
      if (store.disposed) end();
    }
  );
  const end = () => {
    stop();
    if (following.get(store.conversationId) === end) following.delete(store.conversationId);
  };
  following.set(store.conversationId, end);
}
