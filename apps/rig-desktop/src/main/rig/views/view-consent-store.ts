import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '@main/lib/logger';

/**
 * The schedule this Mac's person agreed to for each view (`viewScheduleSignature`), by
 * `bindingId/view`, in a small JSON file in the app's data folder. Not in the space: what one
 * person agreed to must not sync to the others, or anyone could write the agreement along with
 * the schedule. Read once, rewritten atomically on every change; an unreadable file means nothing
 * agreed to, and each schedule waits to be accepted again.
 */
export function createFileViewConsentStore(filePath: string): {
  get(key: string): string | undefined;
  set(key: string, signature: string): void;
} {
  let data: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      );
    }
  } catch {
    // No file yet, or unreadable: start empty.
  }
  return {
    get: (key) => data[key],
    set(key, signature) {
      if (data[key] === signature) return;
      data = { ...data, [key]: signature };
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 2));
        renameSync(tmp, filePath);
      } catch (error) {
        log.warn('Rig views: could not save an accepted schedule', { error: String(error) });
      }
    },
  };
}

/** How long after this Mac's session wrote a `view.json` its schedule still counts as its own. */
export const OWN_WRITE_WINDOW_MS = 3 * 60_000;

/**
 * Which `view.json` files this Mac's own sessions wrote a moment ago, by `bindingId/view`. Marked
 * from the diffs the session's own file tools report; asked by the view clock when it meets a
 * schedule its person has not agreed to. When the write held the whole file, only that exact
 * schedule counts as the session's own. When it held just the changed part, whatever schedule is
 * there counts, for a few minutes only, so a change that syncs in later from another member is
 * never taken for the session's own.
 */
export function createOwnViewWrites(now: () => number, windowMs = OWN_WRITE_WINDOW_MS) {
  const marks = new Map<string, { at: number; signature: string | null }>();
  return {
    /** `signature`: the schedule the write put there (`viewScheduleSignature`), or null when not known. */
    mark(bindingId: string, view: string, signature: string | null): void {
      marks.set(`${bindingId}/${view}`, { at: now(), signature });
    },
    wroteHere(bindingId: string, view: string, signature: string): boolean {
      const key = `${bindingId}/${view}`;
      const mark = marks.get(key);
      if (!mark) return false;
      if (now() - mark.at > windowMs) {
        marks.delete(key);
        return false;
      }
      return mark.signature === null || mark.signature === signature;
    },
  };
}
