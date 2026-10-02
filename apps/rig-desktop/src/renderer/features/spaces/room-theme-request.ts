import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { DockFocus } from './dock-model';
import type { RoomThemes } from './themes';

/**
 * Open a Room on a theme: Home asks (`requestRoomTheme`) right before it
 * opens the space, and the Room focuses that theme's pill once its themes
 * have loaded and include it (`useRoomThemeRequest`). One request at a time;
 * a newer one replaces it, and one the Room never picks up lapses.
 */

const LAPSES_AFTER_MS = 60_000;

type Request = { bindingId: string; themeId: string; at: number };
let pending: Request | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestRoomTheme(bindingId: string, themeId: string): void {
  pending = { bindingId, themeId, at: Date.now() };
  emit();
}

function clearRoomThemeRequest(): void {
  if (!pending) return;
  pending = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function requestedFor(bindingId: string): string | null {
  if (!pending || pending.bindingId !== bindingId) return null;
  return Date.now() - pending.at > LAPSES_AFTER_MS ? null : pending.themeId;
}

/**
 * Focuses the theme Home asked this Room to open on. Call it after the
 * Room's own "another space clears the focus" effect, so that reset never
 * undoes it.
 */
export function useRoomThemeRequest({
  bindingId,
  enabled,
  themes,
  focusOn,
}: {
  bindingId: string;
  /** The dock is on. */
  enabled: boolean;
  themes: RoomThemes | null | undefined;
  focusOn: (target: DockFocus) => void;
}): void {
  const themeId = useSyncExternalStore(subscribe, () => requestedFor(bindingId));
  const known = themeId !== null && themes?.list.some((t) => t.id === themeId) === true;
  // Right after the Room switches space it still holds the last space's
  // themes for a render; a theme found there would be focused and then lost.
  const seen = useRef({ bindingId, themes });
  useEffect(() => {
    const before = seen.current;
    seen.current = { bindingId, themes };
    const stale = before.bindingId !== bindingId && before.themes === themes && themes != null;
    if (stale || !enabled || !known || themeId === null) return;
    focusOn({ kind: 'theme', themeId });
    clearRoomThemeRequest();
  }, [bindingId, themes, enabled, known, themeId, focusOn]);
}
