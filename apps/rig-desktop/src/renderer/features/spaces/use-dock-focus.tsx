import { useCallback, useEffect, useMemo, useState } from 'react';
import { AskDone } from './components/ask-done';
import type { TranscriptFocus } from './components/room-transcript';
import { sameFocus, type DockFocus } from './dock-model';
import type { ForYou } from './for-you';
import type { RoomThemes } from './themes';

/**
 * The dock's focus: which pill the transcript is filtered to. A pill clicked
 * is focused, clicked again (or Esc) is cleared, and a focused theme that
 * disappears (merged into another) clears itself. `transcriptFocus` is what
 * `RoomTranscript` takes.
 */

export type DockFocusState = {
  focus: DockFocus | null;
  /** Focus this, or clear it when it is already the focus. */
  toggle: (target: DockFocus) => void;
  clear: () => void;
  transcriptFocus: TranscriptFocus | undefined;
};

const pluralMessages = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;
const foldOfThemes = (n: number) => `${pluralMessages(n)} in other themes`;
const foldOfForYou = (n: number) => `${pluralMessages(n)} not waiting on you`;

function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

export function useDockFocus({
  enabled,
  themes,
  forYou,
  dismiss,
}: {
  /** The dock is on; off, nothing is focused and nothing listens. */
  enabled: boolean;
  themes: RoomThemes | null | undefined;
  forYou: ForYou | null;
  /** Hides the ask an inbox row belongs to (the "Done" under an ask). */
  dismiss: ((notificationId: string) => void) | null;
}): DockFocusState {
  const [chosen, setChosen] = useState<DockFocus | null>(null);

  // A theme that is gone (merged) is no longer a focus.
  const focus = useMemo<DockFocus | null>(() => {
    if (!enabled || !chosen) return null;
    if (chosen.kind === 'theme' && !themes?.list.some((t) => t.id === chosen.themeId)) return null;
    return chosen;
  }, [enabled, chosen, themes]);
  useEffect(() => {
    if (chosen && !focus) setChosen(null);
  }, [chosen, focus]);

  const toggle = useCallback((target: DockFocus) => {
    setChosen((current) => (sameFocus(current, target) ? null : target));
  }, []);
  const clear = useCallback(() => setChosen(null), []);

  // Esc clears it, unless something else (an open panel, a field) took the key.
  const focused = focus !== null;
  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || typingInField(event.target)) return;
      setChosen(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focused]);

  const themeId = focus?.kind === 'theme' ? focus.themeId : null;
  const forYouFocus = focus?.kind === 'for-you';
  const themeOf = themes?.themeOf;
  const transcriptFocus = useMemo<TranscriptFocus | undefined>(() => {
    if (themeId !== null && themeOf) {
      const messageIds = new Set<string>();
      for (const [messageId, assignment] of Object.entries(themeOf)) {
        if (assignment.themeId === themeId) messageIds.add(messageId);
      }
      return { messageIds, key: themeId, foldLabel: foldOfThemes };
    }
    if (forYouFocus && forYou) {
      const asksByMessage = new Map(forYou.asks.map((ask) => [ask.messageId, ask]));
      return {
        messageIds: forYou.messageIds,
        order: 'asks-first',
        askIds: new Set(asksByMessage.keys()),
        key: 'for-you',
        foldLabel: foldOfForYou,
        askAccessory: (messageId) => {
          const ask = asksByMessage.get(messageId);
          return ask && dismiss ? <AskDone onDone={() => dismiss(ask.notificationId)} /> : null;
        },
      };
    }
    return undefined;
  }, [themeId, themeOf, forYouFocus, forYou, dismiss]);

  return { focus, toggle, clear, transcriptFocus };
}
