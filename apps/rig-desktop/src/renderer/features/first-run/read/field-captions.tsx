import { useCallback, useEffect, useRef, useState } from 'react';
import { SourceLogo } from '@renderer/features/home-feed/bits';
import type { SourceConnector } from '@renderer/features/home-feed/model';
import { cn } from '@renderer/lib/utils';

/**
 * Captions on the Read step's field: a lit tile says what it's reading, its
 * tool's logo and a short label ("#eng-standup") beside it, and fades as the
 * tile settles to grey. A few at a time, so the field reads as work being
 * done, not a wall of text. Drawn as DOM over the stage, at the tile's place
 * (`AgentFieldTile.at`, fractions of the field).
 */

export type FieldCaption = {
  /** The lookup's line id: a later event for it updates the words. */
  id: string;
  at: { x: number; y: number };
  connector: string;
  text: string;
  leaving: boolean;
};

/** At most this many on the field at once; a new one lets the oldest go. */
export const MAX_CAPTIONS = 3;
/** How long a caption takes to fade out. */
const FADE_MS = 350;
const MAX_CHARS = 28;
const KNOWN_LOGOS: ReadonlySet<string> = new Set<SourceConnector>(['slack', 'linear', 'github', 'gmail', 'granola']);

/** A lookup's line as a caption: the channel it reads, else what it searches for, else the line, short. */
export function captionOf(label: string): string {
  const text = /#[\w.-]+/.exec(label)?.[0] ?? /"([^"]+)"/.exec(label)?.[1] ?? label;
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
}

/**
 * The captions on the field: `show` one for a lookup for `ms` (until its tile settles), `rename` it
 * when its line says more, `clear` them all (the gather).
 */
export function useFieldCaptions() {
  const [captions, setCaptions] = useState<FieldCaption[]>([]);
  // The list as it is now, for deciding who steps aside without side effects in a state update.
  const current = useRef<FieldCaption[]>([]);
  const update = useCallback((next: (list: FieldCaption[]) => FieldCaption[]) => {
    current.current = next(current.current);
    setCaptions(current.current);
  }, []);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>[]>());

  const drop = useCallback((id: string) => {
    for (const t of timers.current.get(id) ?? []) clearTimeout(t);
    timers.current.delete(id);
    update((list) => list.map((c) => (c.id === id ? { ...c, leaving: true } : c)));
    timers.current.set(id, [
      setTimeout(() => {
        timers.current.delete(id);
        update((list) => list.filter((c) => c.id !== id));
      }, FADE_MS),
    ]);
  }, [update]);

  const show = useCallback(
    (caption: Omit<FieldCaption, 'leaving'>, ms: number) => {
      if (current.current.some((c) => c.id === caption.id)) return;
      // Room for this one: the oldest step aside.
      const staying = current.current.filter((c) => !c.leaving);
      for (const c of staying.slice(0, Math.max(0, staying.length - (MAX_CAPTIONS - 1)))) drop(c.id);
      update((list) => [...list, { ...caption, leaving: false }]);
      timers.current.set(caption.id, [setTimeout(() => drop(caption.id), Math.max(0, ms - FADE_MS))]);
    },
    [drop, update]
  );

  const rename = useCallback(
    (id: string, text: string) => update((list) => list.map((c) => (c.id === id && c.text !== text ? { ...c, text } : c))),
    [update]
  );

  const clear = useCallback(() => {
    timers.current.forEach((ts) => ts.forEach(clearTimeout));
    timers.current.clear();
    update(() => []);
  }, [update]);

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((ts) => ts.forEach(clearTimeout));
  }, []);

  return { captions, show, rename, clear };
}

/** The captions, placed over the field (`.fr-stage`), each just right of its tile. */
export function FieldCaptions({ captions }: { captions: FieldCaption[] }) {
  const box = typeof document === 'undefined' ? null : document.querySelector('.fr-stage')?.getBoundingClientRect();
  if (!box || !captions.length) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[5]" aria-hidden data-testid="field-captions">
      {captions.map((c) => (
        <span
          key={c.id}
          className={cn('fr-caption', c.leaving && 'fr-caption-leaving')}
          style={{ left: box.left + c.at.x * box.width + 11, top: box.top + c.at.y * box.height }}
          data-caption={c.id}
        >
          {KNOWN_LOGOS.has(c.connector) && <SourceLogo connector={c.connector as SourceConnector} size={11} />}
          <span className="max-w-[170px] truncate">{c.text}</span>
        </span>
      ))}
    </div>
  );
}
