import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { localMatches, mergeMatches, planSearch, type SearchPlan } from './chat-search';
import type { RoomSource } from './room-source';
import type { RoomMessage, RoomSnapshot } from './types';

/**
 * Search in a space's chat: the field's state (open, what's typed), and
 * while a query is in, the matches the transcript shows instead of the
 * chat. Loaded messages match as you type; the relay is asked ~200ms after
 * the last keystroke for the older ones, a page at a time (scrolling up the
 * matches asks for the next). Another space starts over, closed.
 */

const DEBOUNCE_MS = 200;

export type ChatSearchRemote = {
  /** 'offline': the relay couldn't be reached; the loaded matches still show. 'none': this Room has no relay (the scripted demo). */
  status: 'idle' | 'loading' | 'done' | 'offline' | 'none';
  /** The relay has older matches than these. */
  more: boolean;
  /** A next page is on its way. */
  loadingMore: boolean;
};

export type ChatSearch = {
  open: boolean;
  query: string;
  setQuery: (query: string) => void;
  /** Opens the field (or, open, asks it to take focus and select its text again). */
  openSearch: () => void;
  close: () => void;
  /** Bumped by every `openSearch`: the field focuses and selects its text. */
  focusNonce: number;
  /** The plan of the query searched for (the debounced one); null while there is none. */
  plan: SearchPlan | null;
  /** The query `plan` is for. */
  searched: string;
  /** Matches, in chat order; empty while there's no query. */
  matches: RoomMessage[];
  remote: ChatSearchRemote;
  /** The relay's next page of older matches. */
  loadMore: () => void;
};

type RemoteState = {
  query: string;
  messages: RoomMessage[];
  nextBefore: number | null;
  status: ChatSearchRemote['status'];
  loadingMore: boolean;
};

const IDLE: RemoteState = { query: '', messages: [], nextBefore: null, status: 'idle', loadingMore: false };

export function useChatSearch({
  bindingId,
  source,
  snapshot,
}: {
  bindingId: string;
  source: RoomSource | null;
  /** The whole conversation as loaded (not a view of it). */
  snapshot: RoomSnapshot | null;
}): ChatSearch {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [focusNonce, setFocusNonce] = useState(0);
  const [remote, setRemote] = useState<RemoteState>(IDLE);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSearched('');
    setRemote(IDLE);
  }, []);
  const openSearch = useCallback(() => {
    setOpen(true);
    setFocusNonce((n) => n + 1);
  }, []);
  useEffect(() => close(), [bindingId, close]);

  // The query searched for settles ~200ms after the last keystroke; clearing it is immediate.
  useEffect(() => {
    if (!query.trim()) {
      setSearched('');
      return;
    }
    const timer = setTimeout(() => setSearched(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const plan = useMemo(() => planSearch(searched), [searched]);

  // The relay's first page for each query searched; a late answer for an older query is dropped.
  const searchedRef = useRef(searched);
  searchedRef.current = searched;
  useEffect(() => {
    if (!searched) {
      setRemote(IDLE);
      return;
    }
    if (!source?.search) {
      setRemote({ ...IDLE, query: searched, status: 'none' });
      return;
    }
    setRemote({ ...IDLE, query: searched, status: 'loading' });
    const search = source.search.bind(source);
    void search(searched).then(
      (page) => {
        if (searchedRef.current !== searched) return;
        setRemote(
          page.ok
            ? { query: searched, messages: page.messages, nextBefore: page.nextBefore, status: 'done', loadingMore: false }
            : { ...IDLE, query: searched, status: 'offline' }
        );
      },
      () => {
        if (searchedRef.current === searched) setRemote({ ...IDLE, query: searched, status: 'offline' });
      }
    );
  }, [searched, source]);

  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const loadMore = useCallback(() => {
    const current = remoteRef.current;
    if (!source?.search || current.status !== 'done' || current.nextBefore === null || current.loadingMore) return;
    const { query: q, nextBefore } = current;
    setRemote((r) => (r.query === q ? { ...r, loadingMore: true } : r));
    void source.search(q, nextBefore).then(
      (page) => {
        setRemote((r) => {
          if (r.query !== q) return r;
          if (!page.ok) return { ...r, loadingMore: false };
          return { ...r, messages: [...r.messages, ...page.messages], nextBefore: page.nextBefore, loadingMore: false };
        });
      },
      () => setRemote((r) => (r.query === q ? { ...r, loadingMore: false } : r))
    );
  }, [source]);

  const messages = snapshot?.messages;
  const sessionEventsByRun = snapshot?.sessionEventsByRun;
  const sessionSummaryByRun = snapshot?.sessionSummaryByRun;
  const matches = useMemo(() => {
    if (!plan || !messages || !sessionEventsByRun) return [];
    const local = localMatches({ messages, sessionEventsByRun, sessionSummaryByRun }, plan);
    const fromRelay = remote.query === searched ? remote.messages : [];
    return mergeMatches(local, fromRelay, messages);
  }, [plan, messages, sessionEventsByRun, sessionSummaryByRun, remote, searched]);

  const remoteView = useMemo<ChatSearchRemote>(
    () => ({
      status: remote.query === searched ? remote.status : searched ? 'loading' : 'idle',
      more: remote.query === searched && remote.status === 'done' && remote.nextBefore !== null,
      loadingMore: remote.loadingMore,
    }),
    [remote, searched]
  );

  return { open, query, setQuery, openSearch, close, focusNonce, plan, searched, matches, remote: remoteView, loadMore };
}
