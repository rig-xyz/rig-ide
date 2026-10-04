import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { PRODUCT_NAME } from '@shared/app-identity';
import { SETTINGS_PAGES, type SettingsPageId } from './settings-pages';

/** Settings' left rail: search, the pages, and the app's version at the foot. */
export function SettingsRail({
  page,
  onSelectPage,
  query,
  onQueryChange,
}: {
  page: SettingsPageId;
  onSelectPage: (page: SettingsPageId) => void;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const { data: appVersion } = useQuery({
    queryKey: ['rig', 'app', 'version'],
    queryFn: () => rpc.app.getAppVersion(),
  });
  const searching = query.trim().length > 0;

  return (
    <nav aria-label="Settings" className="border-border-hairline flex w-[248px] shrink-0 flex-col gap-3 border-r px-3 pt-4 pb-3">
      <label className="bg-bg-2 focus-within:border-accent/60 flex h-8 items-center gap-2 rounded-control border border-transparent px-2.5">
        <Search className="text-text-muted size-3.5 shrink-0" strokeWidth={1.5} />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search settings"
          aria-label="Search settings"
          className="text-text-primary placeholder:text-text-muted min-w-0 flex-1 bg-transparent text-[13px] outline-none [&::-webkit-search-cancel-button]:hidden"
          data-testid="settings-search"
        />
      </label>
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {SETTINGS_PAGES.map(({ id, title, icon: Icon }) => {
          const current = !searching && page === id;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onSelectPage(id)}
                aria-current={current ? 'page' : undefined}
                data-settings-page={id}
                className={cn(
                  'flex h-8 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] transition-colors',
                  current ? 'glass-selected text-text-primary font-medium' : 'glass-hover text-text-secondary hover:text-text-primary'
                )}
              >
                <Icon className="size-4 shrink-0" strokeWidth={1.5} />
                {title}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-text-muted px-2.5 font-mono text-2xs" data-testid="settings-rail-version">
        {PRODUCT_NAME} {appVersion ?? ''}
      </p>
    </nav>
  );
}
