import { useCallback, useEffect, useMemo, useState } from 'react';
import { AskDone } from './components/ask-done';
import type { TranscriptFocus } from './components/room-transcript';
import { sameFocus, sameWho, spotlightFocus, whoMessageIds, type DockFocus, type DockWho } from './dock-model';
import type { ForYou } from './for-you';
import type { RoomThemes } from './themes';
import type { RoomSnapshot } from './types';

/**
 * The dock's focus: which pill the transcript is filtered to, and whose face
 * (the spotlight). A pill clicked is focused, clicked again (or Esc) is
 * cleared, and a focused theme that disappears (merged into another) clears
 * itself. A face works the same way and combines with a pill: the transcript
 * keeps what is in both. `transcriptFocus` is what `RoomTranscript` takes.
 */

export type DockFocusState = {
  focus: DockFocus | null;
  /** Focus this, or clear it when it is already the focus. */
  toggle: (target: DockFocus) => void;
  /** Focus this, whatever is focused now (Home opening the Room on a theme). */
  focusOn: (target: DockFocus) => void;
  /** Lets go of the pill and the face. */
  clear: () => void;
  /** Lets go of the pill only (its card's ×). */
  clearTopic: () => void;
  /** The face the transcript is filtered to, if any. */
  who: DockWho | null;
  /** Filter to this face, or let go of it when it is already the one. */
  toggleWho: (target: DockWho) => void;
  clearWho: () => void;
  transcriptFocus: TranscriptFocus | undefined;
};

const pluralMessages = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;
const foldOfThemes = (n: number) => `${pluralMessages(n)} in other topics`;
const foldOfForYou = (n: number) => `${pluralMessages(n)} not waiting on you`;


function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

export function useDockFocus({
  enabled,
  snapshot,
  themes,
  forYou,
  dismiss,
}: {
  /** The dock is on; off, nothing is focused and nothing listens. */
  enabled: boolean;
  /** The Room's messages and runs, for whose messages a face holds. */
  snapshot: Pick<RoomSnapshot, 'messages' | 'sessionMetaByRun'> | null | undefined;
  themes: RoomThemes | null | undefined;
  forYou: ForYou | null;
  /** Hides the ask an inbox row belongs to (the "Done" under an ask). */
  dismiss: ((notificationId: string) => void) | null;
}): DockFocusState {
  const [chosen, setChosen] = useState<DockFocus | null>(null);
  const [chosenWho, setChosenWho] = useState<DockWho | null>(null);
  const who = enabled ? chosenWho : null;

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
  const focusOn = useCallback((target: DockFocus) => setChosen(target), []);
  const clearTopic = useCallback(() => setChosen(null), []);
  const toggleWho = useCallback((target: DockWho) => {
    setChosenWho((current) => (sameWho(current, target) ? null : target));
  }, []);
  const clearWho = useCallback(() => setChosenWho(null), []);
  const clear = useCallback(() => {
    setChosen(null);
    setChosenWho(null);
  }, []);

  // Esc clears both, unless something else (an open panel, a field) took the key.
  const focused = focus !== null || who !== null;
  useEffect(() => {
    if (!focused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || typingInField(event.target)) return;
      setChosen(null);
      setChosenWho(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focused]);

  const themeId = focus?.kind === 'theme' ? focus.themeId : null;
  const forYouFocus = focus?.kind === 'for-you';
  const themeOf = themes?.themeOf;
  const topicFocus = useMemo<TranscriptFocus | undefined>(() => {
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

  // The face's messages, and what the topic keeps of them.
  const whoIds = useMemo(
    () => (who && snapshot ? whoMessageIds(snapshot, who) : null),
    [who, snapshot]
  );
  const transcriptFocus = useMemo(
    () => spotlightFocus(topicFocus, who && whoIds ? { who, messageIds: whoIds } : null, forYouFocus),
    [who, whoIds, topicFocus, forYouFocus]
  );

  return { focus, toggle, focusOn, clear, clearTopic, who, toggleWho, clearWho, transcriptFocus };
}
