import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { AboutPage } from './pages/about-page';
import { AccountPage } from './pages/account-page';
import { AdvancedPage } from './pages/advanced-page';
import { AgentsPage } from './pages/agents-page';
import { GeneralPage, type ThemePreference } from './pages/general-page';
import { NotificationsPage } from './pages/notifications-page';
import { PrivacyPage } from './pages/privacy-page';
import { SignInsPage } from './pages/sign-ins-page';
import { SpacesPage } from './pages/spaces-page';
import {
  readLastSettingsPage,
  searchSettings,
  settingsPageMeta,
  writeLastSettingsPage,
  type SettingsPageId,
  type SettingsRowEntry,
} from './settings-pages';
import { SettingsRail } from './settings-rail';
import { SettingsHighlightContext } from './settings-row';

/** How long a row found by search stays highlighted. */
const HIGHLIGHT_MS = 1600;

/**
 * Settings, one page per topic (canvas board 23): a sheet over almost the
 * whole window, a rail of pages on the left, one page on the right. Esc and
 * a click on the scrim close it (Base UI's Dialog). Opens on `initialPage`
 * when given, otherwise on the page last viewed on this computer.
 */
export function SettingsSheet({
  open,
  onOpenChange,
  themePreference,
  onSetThemePreference,
  initialPage = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  themePreference: ThemePreference;
  onSetThemePreference: (next: ThemePreference) => void;
  initialPage?: SettingsPageId | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="settings-sheet"
        backdropClassName="bg-black/20"
        className="top-[68px] right-10 bottom-7 left-10 max-h-none w-auto max-w-none translate-x-0 translate-y-0 flex-row rounded-[26px]"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <SettingsBody
          initialPage={initialPage}
          themePreference={themePreference}
          onSetThemePreference={onSetThemePreference}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the sheet is open, so each open starts on the right page with an empty search. */
function SettingsBody({
  initialPage,
  themePreference,
  onSetThemePreference,
}: {
  initialPage: SettingsPageId | null;
  themePreference: ThemePreference;
  onSetThemePreference: (next: ThemePreference) => void;
}) {
  const [page, setPage] = useState<SettingsPageId>(() => initialPage ?? readLastSettingsPage());
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => writeLastSettingsPage(page), [page]);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [page]);
  useEffect(() => {
    if (!highlight) return;
    const row = scrollRef.current?.querySelector(`[data-settings-row="${highlight}"]`);
    row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  const selectPage = (next: SettingsPageId) => {
    setQuery('');
    setHighlight(null);
    setPage(next);
  };
  const jumpTo = (row: SettingsRowEntry) => {
    setQuery('');
    setPage(row.page);
    setHighlight(row.id);
  };

  const searching = query.trim().length > 0;
  const meta = settingsPageMeta(page);

  return (
    <>
      <SettingsRail page={page} onSelectPage={selectPage} query={query} onQueryChange={setQuery} />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="absolute top-3 right-3 z-10">
          <DialogClose />
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-10 pt-10 pb-12">
          <div className="mx-auto w-full max-w-[760px]">
            {searching ? (
              <SearchResults query={query} onPick={jumpTo} />
            ) : (
              <section aria-labelledby="settings-page-title" data-settings-current-page={page}>
                <h2 id="settings-page-title" className="text-text-primary text-[24px] leading-tight font-semibold tracking-[-0.3px]">
                  {meta.title}
                </h2>
                <p className="text-text-muted mt-1.5 mb-5 text-[13px]">{meta.lede}</p>
                <SettingsHighlightContext.Provider value={highlight}>
                  <SettingsPage page={page} themePreference={themePreference} onSetThemePreference={onSetThemePreference} />
                </SettingsHighlightContext.Provider>
              </section>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function SettingsPage({
  page,
  themePreference,
  onSetThemePreference,
}: {
  page: SettingsPageId;
  themePreference: ThemePreference;
  onSetThemePreference: (next: ThemePreference) => void;
}) {
  switch (page) {
    case 'general':
      return <GeneralPage themePreference={themePreference} onSetThemePreference={onSetThemePreference} />;
    case 'account':
      return <AccountPage />;
    case 'agents':
      return <AgentsPage />;
    case 'spaces':
      return <SpacesPage />;
    case 'notifications':
      return <NotificationsPage />;
    case 'sign-ins':
      return <SignInsPage />;
    case 'privacy':
      return <PrivacyPage />;
    case 'advanced':
      return <AdvancedPage />;
    case 'about':
      return <AboutPage />;
  }
}

function SearchResults({ query, onPick }: { query: string; onPick: (row: SettingsRowEntry) => void }) {
  const results = searchSettings(query);
  return (
    <section aria-label="Search results">
      <h2 className="text-text-primary text-[24px] leading-tight font-semibold tracking-[-0.3px]">Search</h2>
      {results.length === 0 ? (
        <p className="text-text-muted mt-1.5 text-[13px]" data-testid="settings-search-empty">
          No settings match “{query.trim()}”.
        </p>
      ) : (
        <ul className="divide-border-hairline mt-4 flex flex-col divide-y">
          {results.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onPick(row)}
                data-settings-result={row.id}
                className="glass-hover -mx-3 flex w-[calc(100%+1.5rem)] items-center gap-4 rounded-control px-3 py-3 text-left"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-text-primary text-[14px] font-medium">{row.label}</span>
                  <span className="text-text-muted text-[12.5px]">{row.description}</span>
                </span>
                <span className="text-text-muted shrink-0 text-xs">{settingsPageMeta(row.page).title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
