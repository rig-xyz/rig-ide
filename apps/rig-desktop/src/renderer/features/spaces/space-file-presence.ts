import { useContext, useEffect, useState } from 'react';
import { AttachmentSpaceContext, type AttachmentSpace } from './components/attachment-cards';
import { resolveSpaceLink, type SpaceLink } from './space-link';

/**
 * Is a file the chat points at actually on this computer yet?
 *
 * A file made on someone else's computer reaches this one only once sync
 * brings it; until then the chat must not offer it as if it could open
 * ("Could not open document: Path is not available." was the old answer).
 * Links, file chips and changed-file cards ask here, show "not on this
 * computer yet" meanwhile, and keep asking — cheaply, one shared check per
 * file — so they turn into ordinary links the moment it lands.
 */

export const NOT_HERE_YET_TITLE = 'Not on this computer yet';
export const NOT_HERE_YET_DETAIL = 'It will open once it syncs.';

/** The sentence for a file that isn't here yet, naming who it's coming from when that's known. */
export function notHereYetText(from?: string | null): string {
  return from ? `Arriving from ${from}… it will open once it syncs.` : `${NOT_HERE_YET_TITLE} — it will open once it syncs.`;
}

const POLL_MS = 4000;
/** Stop re-checking a missing file after this long on screen (checked again when it's shown again). */
const POLL_WINDOW_MS = 30 * 60 * 1000;
/** One status read per file per this long, however many chips show it. */
const SHARED_MS = 2500;

const checks = new Map<string, { at: number; exists: Promise<boolean | null> }>();

/** Whether `relPath` is in the space on this computer; null when that can't be told. */
export function checkPresence(space: AttachmentSpace, relPath: string): Promise<boolean | null> {
  const key = `${space.bindingId}:${relPath}`;
  const hit = checks.get(key);
  if (hit && Date.now() - hit.at < SHARED_MS) return hit.exists;
  const exists = space
    .status([{ path: relPath }], false)
    .then((result) => (result ? !!result.find((s) => s.path === relPath)?.exists : null))
    .catch(() => null);
  checks.set(key, { at: Date.now(), exists });
  return exists;
}

export type SpaceFile = {
  link: SpaceLink | null;
  /** Inside the space: its path there. */
  relPath: string | null;
  /** On this computer: true/false, or null while unknown (not checked yet, no space, no folder). */
  present: boolean | null;
};

/** Resolves `link` against the Room's space and follows whether it's here, re-checking while it isn't. */
export function useSpaceFile(link: string | null): SpaceFile {
  const space = useContext(AttachmentSpaceContext);
  const root = space?.spaceRoot ?? null;
  const resolved = link && root ? resolveSpaceLink(link, root) : null;
  const relPath = resolved?.kind === 'inside' ? resolved.relPath : null;
  const [present, setPresent] = useState<boolean | null>(null);

  useEffect(() => {
    setPresent(null);
    if (!space || !relPath) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();
    const check = async () => {
      const exists = await checkPresence(space, relPath);
      if (!alive) return;
      setPresent(exists);
      if (exists === false && Date.now() - started < POLL_WINDOW_MS) timer = setTimeout(() => void check(), POLL_MS);
    };
    void check();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [space, relPath]);

  return { link: resolved, relPath, present };
}
