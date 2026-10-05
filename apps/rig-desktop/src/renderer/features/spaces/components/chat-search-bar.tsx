import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { matchCountLabel } from '../chat-search';
import type { ChatSearch } from '../use-chat-search';

/**
 * The field Cmd-F opens at the top of a space's chat. While a query is in,
 * the transcript below shows only what matches; the bar says how many, and
 * × or Esc closes it and puts the chat back where it was. Cmd-F again
 * selects what's typed.
 */
export function ChatSearchBar({ search }: { search: ChatSearch }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!search.open) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [search.open, search.focusNonce]);

  if (!search.open) return null;

  const { remote, searched, matches } = search;
  const status = !searched
    ? null
    : matches.length > 0
      ? matchCountLabel(matches.length, searched, remote.more)
      : remote.status === 'loading'
        ? 'Searching…'
        : `No matches for “${searched}”`;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 px-3 pt-2" data-testid="chat-search">
      <div className="pointer-events-auto mx-auto flex max-w-[44rem] flex-col gap-1">
        <label className="border-border-hairline bg-bg-1 shadow-float focus-within:border-accent/60 flex h-9 items-center gap-2 rounded-control border px-3">
          <Search className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.75} />
          <input
            ref={inputRef}
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              search.close();
            }}
            placeholder="Search this space’s chat"
            aria-label="Search this space’s chat"
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
            data-testid="chat-search-input"
          />
          {status && (
            <span className="shrink-0 text-xs text-text-muted" aria-live="polite" data-testid="chat-search-status">
              {status}
            </span>
          )}
          <button
            type="button"
            onClick={search.close}
            aria-label="Close search"
            title="Close search"
            className="hover:bg-bg-2 -mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors"
            data-testid="chat-search-close"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </label>
        {searched && remote.status === 'offline' && (
          <p className="px-3 text-xs text-text-muted" data-testid="chat-search-offline">
            Search needs a connection for older messages
          </p>
        )}
      </div>
    </div>
  );
}
