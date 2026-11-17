import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRoomStatus } from '@renderer/features/spaces/room-status-store';
import { events, rpc } from '@renderer/lib/ipc';
import { rigFileChangeChannel } from '@shared/rig/files';
import {
  checkViewAct,
  viewDataPath,
  viewIndexPath,
  viewLinkToOpen,
  viewMessageHasGesture,
} from '@shared/rig/views';
import viewRuntime from './_runtime/rig-view.hosted.js?raw';
import { viewTurnStarted } from './view-activity';
import { buildViewDoc, VIEW_SANDBOX } from '@shared/rig/view-doc';
import viewCss from './_runtime/rig.css?raw';

/**
 * A Rig view, hosted (spike, behind Rig Alpha). Port of `mountRigView` from the host spike.
 *
 * The page the agent wrote runs in a frame with an opaque origin and no network: it cannot reach
 * this document, storage, cookies or the space's files. Everything it has, this component hands it
 * by message (its data, and who is looking); the only thing it can send back is `rig:act`, checked
 * here and again in main before a turn starts in the member's own session.
 */

/**
 * Who is looking. `id` is their relay user id: the stable key a view's data is written against
 * ("this step is for usr_…"). `name` is only a label to show; it is not unique and people change it.
 */
function readAppTheme(): 'light' | 'dark' | null {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || theme === 'dark' ? theme : null;
}

type Viewer = { id: string; name: string | null };

export function RigViewHost({
  rootId,
  bindingId,
  name,
}: {
  rootId: string;
  bindingId: string;
  name: string;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  /** The last data.json that parsed, re-serialised. A half-written file keeps the previous one on screen. */
  const dataText = useRef<string | null>(null);
  const lastOpened = useRef(0);

  const me = useQuery({ queryKey: ['rig', 'account', 'me'], queryFn: () => rpc.rig.account.me() });
  const user = me.data?.success ? me.data.data : null;
  const viewerId = user?.id ?? null;
  const viewerName = user?.name ?? null;
  const viewer = useRef<Viewer | null>(null);
  viewer.current = viewerId ? { id: viewerId, name: viewerName } : null;

  // Who is in the space, so a view can show people by name from the ids in its data.
  const room = useRoomStatus(bindingId);
  const peopleText = JSON.stringify(
    (room?.members ?? [])
      .filter((member) => member.status !== 'invited')
      .map((member) => ({ id: member.id, name: member.name }))
  );
  const people = useRef(peopleText);
  people.current = peopleText;

  const send = useCallback(() => {
    const target = frameRef.current?.contentWindow;
    if (!target || dataText.current === null) return;
    // '*': the frame's origin is opaque, so there is no origin to name. The data is the view's own.
    target.postMessage(
      {
        type: 'rig:data',
        text: dataText.current,
        viewer: viewer.current,
        people: JSON.parse(people.current),
      },
      '*'
    );
  }, []);

  // The viewer arriving (or changing) re-renders the view for them.
  useEffect(send, [send, viewerId, viewerName, peopleText]);

  const load = useCallback(async () => {
    const [page, data] = await Promise.all([
      rpc.rig.files.read({ rootId, relativePath: viewIndexPath(name) }),
      rpc.rig.files.read({ rootId, relativePath: viewDataPath(name) }),
    ]);
    if (!page.success) {
      setProblem(page.error.message);
      return;
    }
    setProblem(null);
    setHtml(page.data.content);
    if (!data.success || data.data.truncated) return;
    let text: string;
    try {
      text = JSON.stringify(JSON.parse(data.data.content));
    } catch {
      return;
    }
    if (text === dataText.current) return;
    dataText.current = text;
    send();
  }, [rootId, name, send]);

  // Follow the files: the same change signal the file list and open docs use.
  useEffect(() => {
    void load();
    void rpc.rig.files.watch({ rootId });
    const off = events.on(rigFileChangeChannel, ({ rootId: changed }) => {
      if (changed === rootId) void load();
    });
    return () => {
      off();
      void rpc.rig.files.unwatch({ rootId });
    };
  }, [rootId, load]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return; // only this view's frame
      const message: unknown = event.data;
      if (!message || typeof message !== 'object') return;
      const { type, intent, payload, label, item } = message as {
        type?: unknown;
        intent?: unknown;
        payload?: unknown;
        label?: unknown;
        item?: unknown;
      };
      if (type === 'rig:ready') return send();
      if (type === 'rig:open') {
        // A link the person clicked in the view: their own browser opens it. Web addresses only,
        // only on a real click in the frame (the message carries the gesture), and not in bursts.
        const url = viewLinkToOpen((message as { url?: unknown }).url);
        const now = Date.now();
        if (!url || !viewMessageHasGesture(event) || now - lastOpened.current < 800) return;
        lastOpened.current = now;
        void rpc.app.openExternal(url);
        return;
      }
      if (type !== 'rig:act') return;
      // Only a real press starts a turn in the viewer's session: a page that sends a choice by
      // itself (anyone in the space can edit the page) is ignored.
      if (!viewMessageHasGesture(event)) return;
      if (checkViewAct({ intent, payload })) return;
      setActError(null);
      const turnOver = viewTurnStarted(bindingId, name);
      // The view and the person come from here, never from the page.
      void rpc.rig.spacesDispatch
        .viewAct({
          bindingId,
          view: name,
          intent: intent as string,
          payload: (payload ?? {}) as Record<string, string>,
          // The words on the button and the item's title, for the line the Room shows above the reply.
          ...(typeof label === 'string' && label ? { label } : {}),
          ...(typeof item === 'string' && item ? { item } : {}),
        })
        .then(async (result) => {
          // Tell the view when its turn is over, so a step it shows as sent is offered again
          // if the session left the data as it was.
          const tell = (ok: boolean, message?: string) =>
            frameRef.current?.contentWindow?.postMessage(
              { type: 'rig:act-result', ok, message },
              '*'
            );
          if (!result.success) {
            setActError(result.error);
            return tell(false, result.error);
          }
          // A repeat of a choice already on its way: no turn of its own, nothing to tell the view.
          const runId = result.data.runId;
          if (!runId) return;
          const { ok } = await rpc.rig.spacesDispatch.viewActDone({ runId });
          tell(ok, ok ? undefined : "Your session couldn't finish that");
        })
        .finally(turnOver);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [bindingId, name, send]);

  // The app's own theme (a person can set it apart from their system's), followed live.
  const [theme, setTheme] = useState(readAppTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readAppTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  const doc = useMemo(
    () => (html === null ? null : buildViewDoc(html, viewCss, viewRuntime, theme)),
    [html, theme]
  );

  if (problem) {
    return (
      <div className="px-8 py-8 text-sm text-text-muted">
        This view couldn't be opened: {problem}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="rig-view-host" data-view={name}>
      {doc !== null && (
        <iframe
          ref={frameRef}
          title={name}
          sandbox={VIEW_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={doc}
          className="block min-h-0 w-full flex-1 border-0"
        />
      )}
      {actError && (
        <div
          role="status"
          className="shrink-0 border-t border-border-hairline bg-bg-2 px-4 py-1.5 text-xs text-text-muted"
        >
          That didn't reach your session: {actError}
        </div>
      )}
    </div>
  );
}
