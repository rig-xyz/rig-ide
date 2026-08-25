/**
 * chat-transcript.tsx — React adapter for @emdash/chat-ui.
 *
 * Ported verbatim from emdash-desktop's renderer-local copy
 * (`renderer/lib/chat/chat-transcript.tsx`), which itself exists so the host
 * app's only `@emdash/ui` runtime import is `ChatComposer`. This app doesn't
 * even use that — see `features/chat/chat-panel.tsx` for why (a native
 * composer, to avoid pulling in @emdash/ui's own `--em-*` token system for
 * chrome that needs to render in *this* app's tokens).
 *
 * Uses React.createElement (no JSX) to avoid dual-JSX-runtime conflicts.
 * Creates a ChatView into the container div on mount and disposes on unmount.
 *
 * context + state must be created by the host via createChatContext /
 * createChatState before passing them in. This mirrors the CodeMirror
 * EditorState/EditorView split: the host owns the model (ChatState), this
 * component owns the DOM view.
 *
 * padTop is accepted as a prop and pushed reactively through setContentPadding.
 * padBottom is intentionally omitted — this app never uses `composer: 'slot'`,
 * so the host drives padBottom itself via `view.setContentPadding({ bottom })`
 * from the `onReady` handle (see chat-panel.tsx's composer ResizeObserver).
 *
 * commands / onReachStart / onAtBottomChange are pushed reactively so inline
 * callbacks do not go stale after React re-renders.
 */

import type {
  ChatCommands,
  ChatContext,
  ChatState,
  ChatView,
  ChatViewOptions,
} from '@emdash/chat-ui';
import { createElement, useEffect, useRef, useState } from 'react';
import { reportRendererFailure } from '@renderer/features/recovery/renderer-error-reporting';

export type ChatTranscriptProps = Pick<
  ChatViewOptions,
  | 'stickToBottom'
  | 'pinUserMessages'
  | 'class'
  | 'contentClass'
  | 'onReachStart'
  | 'onAtBottomChange'
> & {
  /** Global services singleton shared across conversations. */
  context: ChatContext;
  /** Per-conversation state (transcript + parse caches). */
  state: ChatState;
  /** Called once after the Solid root is mounted with the chat view handle. */
  onReady?: (view: ChatView) => void;
  style?: React.CSSProperties;
  className?: string;
  /**
   * Top padding (px) reserved inside the canvas for a pinned header. Pushed
   * reactively via setContentPadding so it can change without remounting.
   */
  padTop?: number;
  /**
   * Command callbacks invoked by user interactions inside the transcript.
   * Pushed reactively so inline callbacks are never stale.
   */
  commands?: ChatCommands;
};

export function ChatTranscript(props: ChatTranscriptProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const viewRef = useRef<ChatView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    let disposed = false;
    let createdView: ChatView | null = null;

    void import('@emdash/chat-ui')
      .then(({ createChatView }) => {
        if (disposed || !ref.current) return;
        // The lazy import can settle after the active session changes. Read
        // current props here so it cannot create a view for the transcript
        // that originally started the import.
        const p = propsRef.current;
        const view = createChatView({
          context: p.context,
          state: p.state,
          parent: ref.current,
          stickToBottom: p.stickToBottom,
          pinUserMessages: p.pinUserMessages,
          class: p.class,
          contentClass: p.contentClass,
          commands: p.commands ?? {},
          padTop: p.padTop,
          // Thread stable wrappers that read from propsRef at call time — never stale.
          onReachStart: p.onReachStart ? () => propsRef.current.onReachStart?.() : undefined,
          onAtBottomChange: p.onAtBottomChange
            ? (b: boolean) => propsRef.current.onAtBottomChange?.(b)
            : undefined,
          onViewMounted: (v) => propsRef.current.onReady?.(v),
        });
        createdView = view;
        viewRef.current = view;
      })
      .catch((error: unknown) => {
        if (disposed) return;
        reportRendererFailure('unhandled-error', error);
        setLoadError(true);
      });

    return () => {
      disposed = true;
      createdView?.dispose();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAttempt]);

  // Swap the underlying ChatState when props.state identity changes (setModel path).
  useEffect(() => {
    viewRef.current?.setModel(props.state);
  }, [props.state]);

  // Push top padding updates reactively.
  useEffect(() => {
    viewRef.current?.setContentPadding({ top: props.padTop });
  }, [props.padTop]);

  // Push command callbacks reactively so inline functions are never stale.
  useEffect(() => {
    if (props.commands !== undefined) {
      viewRef.current?.setCommands(props.commands);
    }
  }, [props.commands]);

  if (loadError) {
    return createElement(
      'div',
      {
        className: props.className,
        style: {
          alignItems: 'center',
          color: 'var(--text-secondary)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          height: '100%',
          justifyContent: 'center',
          padding: 16,
        },
      },
      createElement('span', null, 'Transcript could not load.'),
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => {
            setLoadError(false);
            setLoadAttempt((attempt) => attempt + 1);
          },
          style: {
            border: '1px solid var(--border-hairline)',
            borderRadius: 6,
            padding: '4px 10px',
          },
        },
        'Retry transcript'
      )
    );
  }
  return createElement('div', {
    ref,
    style: { height: '100%', ...props.style },
    className: props.className,
  });
}

// Re-export imperative types so consumers don't need to import from @emdash/chat-ui directly.
export type {
  ChatView,
  ChatCommands,
  MentionProvider,
  ChatContext,
  ChatState,
  TranscriptTurn,
} from '@emdash/chat-ui';
