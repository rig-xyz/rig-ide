import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copy-to-clipboard with copied-state feedback, auto-resetting after
 * `resetMs`. This app's renderer had no equivalent — `@emdash/chat-ui` has
 * one (`createClipboard`), but it's a Solid.js primitive and can't be used
 * from React. Same shape (`copied`/`copy`), written as a React hook instead.
 */
export function useClipboard(resetMs = 1500): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    },
    []
  );

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(
        () => {
          setCopied(true);
          if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
          timeoutRef.current = window.setTimeout(() => setCopied(false), resetMs);
        },
        // Quiet failure feedback — a rejection (clipboard permission
        // denied, an insecure context) used to be an unhandled promise
        // rejection with `copied` silently staying false forever; this at
        // least surfaces it somewhere rather than swallowing it outright.
        (error: unknown) => {
          console.warn('useClipboard: writeText failed', error);
        }
      );
    },
    [resetMs]
  );

  return { copied, copy };
}
