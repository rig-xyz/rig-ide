import { useContext, useEffect, useRef, useState } from 'react';
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
/** While a file stays missing here, the relay is asked about it only this often; this computer is still checked every `POLL_MS`. */
const RELAY_MS = 60_000;
/** Stop re-checking a missing file after this long on screen (checked again when it's shown again). */
const POLL_WINDOW_MS = 30 * 60 * 1000;
/** One status read per file per this long, however many chips show it. */
const SHARED_MS = 2500;

type Presence = { exists: boolean; /** Missing here: whether the relay has it; null when that can't be told. */ onRelay: boolean | null };
const checks = new Map<string, { at: number; found: Promise<Presence | null> }>();
/** What the relay last said about a file missing here, and when. */
const relayAnswers = new Map<string, { at: number; onRelay: boolean | null }>();

/** Where `relPath` is: on this computer, and when it isn't, whether anyone has shared it; null when that can't be told. */
function checkFile(space: AttachmentSpace, relPath: string): Promise<Presence | null> {
  const key = `${space.bindingId}:${relPath}`;
  const hit = checks.get(key);
  if (hit && Date.now() - hit.at < SHARED_MS) return hit.found;
  const read = (withRelay: boolean) =>
    space.status([{ path: relPath }], withRelay).then((result) => result?.find((s) => s.path === relPath) ?? null);
  const found = read(false)
    .then(async (here): Promise<Presence | null> => {
      if (!here) return null;
      if (here.exists) return { exists: true, onRelay: null };
      // Missing here: the relay's file list says whether it is on its way or was never shared.
      const known = relayAnswers.get(key);
      if (known && Date.now() - known.at < RELAY_MS) return { exists: false, onRelay: known.onRelay };
      const there = await read(true).catch(() => null);
      if (there) relayAnswers.set(key, { at: Date.now(), onRelay: there.onRelay ?? null });
      return { exists: !!there?.exists, onRelay: there?.onRelay ?? null };
    })
    .catch(() => null);
  checks.set(key, { at: Date.now(), found });
  return found;
}

/** Whether `relPath` is in the space on this computer; null when that can't be told. */
export function checkPresence(space: AttachmentSpace, relPath: string): Promise<boolean | null> {
  return checkFile(space, relPath).then((found) => (found ? found.exists : null));
}

export type SpaceFile = {
  link: SpaceLink | null;
  /** Inside the space: its path there. */
  relPath: string | null;
  /** On this computer: true/false, or null while unknown (not checked yet, no space, no folder). */
  present: boolean | null;
  /** Not here and not on the relay either: nobody has shared such a file, so nothing is on its way. */
  nowhere: boolean;
};

/** Resolves `link` against the Room's space and follows whether it's here, re-checking while it isn't. */
export function useSpaceFile(link: string | null): SpaceFile {
  const space = useContext(AttachmentSpaceContext);
  const root = space?.spaceRoot ?? null;
  const resolved = link && root ? resolveSpaceLink(link, root, space?.bindingId) : null;
  const relPath = resolved?.kind === 'inside' ? resolved.relPath : null;
  const [present, setPresent] = useState<boolean | null>(null);
  const [nowhere, setNowhere] = useState(false);

  // The space object is rebuilt whenever the Room re-renders with a new handler; only a different
  // space or file starts the check over. Otherwise a missing file would blink between "unknown"
  // and "not here yet" on every such render (an agent writing files causes many).
  const spaceRef = useRef(space);
  spaceRef.current = space;
  const bindingId = space?.bindingId ?? null;

  useEffect(() => {
    setPresent(null);
    setNowhere(false);
    const space = spaceRef.current;
    if (!space || !relPath) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();
    const check = async () => {
      const found = await checkFile(spaceRef.current ?? space, relPath);
      if (!alive) return;
      const exists = found ? found.exists : null;
      setPresent(exists);
      setNowhere(exists === false && found?.onRelay === false);
      if (exists === false && Date.now() - started < POLL_WINDOW_MS) timer = setTimeout(() => void check(), POLL_MS);
    };
    void check();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [bindingId, root, relPath]);

  return { link: resolved, relPath, present, nowhere };
}
