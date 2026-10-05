import { Bell, Bot, FlaskConical, Info, KeyRound, ShieldCheck, SlidersHorizontal, UserRound, UsersRound } from 'lucide-react';

/**
 * Settings, one page per topic (canvas board 23). The page list, each
 * page's title and lede, and the search index: every fixed row by its label
 * and its one sentence, so search can filter across pages without mounting
 * them. A row's `id` is the `data-settings-row` its page renders, which is
 * how a search result finds the row to scroll to and highlight.
 */

export type SettingsPageId =
  | 'general'
  | 'account'
  | 'agents'
  | 'spaces'
  | 'notifications'
  | 'sign-ins'
  | 'privacy'
  | 'advanced'
  | 'about';

export type SettingsPageMeta = {
  id: SettingsPageId;
  title: string;
  lede: string;
  icon: typeof Bell;
};

export const SETTINGS_PAGES: readonly SettingsPageMeta[] = [
  {
    id: 'general',
    title: 'General',
    lede: 'How Rig looks, where it keeps your rigs, and how it stays up to date.',
    icon: SlidersHorizontal,
  },
  { id: 'account', title: 'Account', lede: 'Who you are signed in as on this computer.', icon: UserRound },
  {
    id: 'agents',
    title: 'Agents',
    lede: 'The agents on this computer and how much they can do without asking.',
    icon: Bot,
  },
  {
    id: 'spaces',
    title: 'Spaces',
    lede: "How a space's chat looks to you and how much of your agent's work others see.",
    icon: UsersRound,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    lede: 'When Rig taps you on the shoulder. Each space can also be set from its menu.',
    icon: Bell,
  },
  { id: 'sign-ins', title: 'Sign-ins', lede: 'How pages beside your chat stay signed in.', icon: KeyRound },
  { id: 'privacy', title: 'Privacy', lede: 'What leaves this computer, and what never does.', icon: ShieldCheck },
  {
    id: 'advanced',
    title: 'Advanced',
    lede: "New settings start here. Once they've settled, they move to their own page.",
    icon: FlaskConical,
  },
  { id: 'about', title: 'About', lede: 'The versions on this computer.', icon: Info },
];

export function settingsPageMeta(id: SettingsPageId): SettingsPageMeta {
  return SETTINGS_PAGES.find((page) => page.id === id) ?? SETTINGS_PAGES[0]!;
}

export function isSettingsPageId(value: unknown): value is SettingsPageId {
  return SETTINGS_PAGES.some((page) => page.id === value);
}

export type SettingsRowEntry = { id: string; page: SettingsPageId; label: string; description: string };

/** Every fixed row, in page order. Lists that change (agents, sign-in sites) are found by their row's own label. */
export const SETTINGS_ROWS: readonly SettingsRowEntry[] = [
  { id: 'theme', page: 'general', label: 'Theme', description: 'Match your Mac, or pick one.' },
  {
    id: 'rig-folder',
    page: 'general',
    label: 'Rig folder',
    description: 'New rigs are created here. Rigs you already have stay where they are.',
  },
  {
    id: 'updates',
    page: 'general',
    label: 'Updates',
    description: 'Rig updates itself in the background and asks before restarting.',
  },
  { id: 'signed-in', page: 'account', label: 'Signed in', description: 'The account Rig uses on this computer.' },
  {
    id: 'sign-out',
    page: 'account',
    label: 'Sign out',
    description: 'Sync pauses for your spaces on this computer until you sign back in, and the Rig command line signs out too.',
  },
  {
    id: 'delete-account',
    page: 'account',
    label: 'Delete account',
    description: 'Deletes your account after 7 days. Signing back in before then cancels it.',
  },
  { id: 'agents-list', page: 'agents', label: 'Agents', description: 'Claude, Codex and the other agents Rig can run.' },
  {
    id: 'ask-before-acting',
    page: 'agents',
    label: 'Ask before acting on comments',
    description:
      "When someone mentions an agent in a comment, it asks you before it changes anything. Keep this on in spaces with people you don't know well.",
  },
  {
    id: 'chat-view',
    page: 'spaces',
    label: 'Chat view',
    description: 'Threads folds every reply under the message it answers. Flow keeps one timeline.',
  },
  {
    id: 'room-sees-default',
    page: 'spaces',
    label: "What others see of your agent's work",
    description: 'The default for spaces you join. Change it for one space from its menu.',
  },
  { id: 'macos-banners', page: 'notifications', label: 'Banners in macOS', description: 'Whether macOS lets Rig show banners.' },
  { id: 'banner-scope', page: 'notifications', label: 'Show banners for', description: 'Which activity gets a banner.' },
  {
    id: 'quiet-while-using',
    page: 'notifications',
    label: "Quiet while I'm using Rig",
    description: 'Banners wait until you switch to another app. Activity still keeps count.',
  },
  { id: 'sound', page: 'notifications', label: 'Play a sound', description: 'A short sound with each banner.' },
  { id: 'dock-badge', page: 'notifications', label: 'Unread count on the Dock', description: 'The same number as the bell in Rig.' },
  {
    id: 'browser-sign-ins',
    page: 'sign-ins',
    label: 'Browser sign-ins',
    description: 'Pages you open beside a chat open signed in as you.',
  },
  {
    id: 'usage-data',
    page: 'privacy',
    label: 'Usage data',
    description: "Counts like daily use, which agents you run and error types. Never what's in your files or chats.",
  },
  { id: 'privacy-policy', page: 'privacy', label: 'Privacy policy', description: 'What Rig Labs collects and why.' },
  { id: 'terms', page: 'privacy', label: 'Terms of service', description: 'The agreement for using Rig.' },
  {
    id: 'topics',
    page: 'advanced',
    label: 'Topics',
    description: "Sort a busy space's chat into the topics people are talking about.",
  },
  {
    id: 'open-spaces-instantly',
    page: 'advanced',
    label: 'Open spaces instantly',
    description: "Keep each space's recent messages on this computer, so it opens at once and catches up.",
  },
  { id: 'app-version', page: 'about', label: 'Rig', description: 'The version of this app.' },
  { id: 'cli-version', page: 'about', label: 'Rig command line', description: 'The rig command your agents and terminal use.' },
  { id: 'sync-version', page: 'about', label: 'Sync', description: 'What keeps your rigs in step with everyone else.' },
  { id: 'website', page: 'about', label: 'Website', description: 'News, help and downloads.' },
];

export function settingsRow(id: string): SettingsRowEntry | undefined {
  return SETTINGS_ROWS.find((row) => row.id === id);
}

/** Rows whose label or description holds every word of `query`, case-insensitive. Empty query, no results. */
export function searchSettings(query: string): SettingsRowEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_ROWS.filter((row) => {
    const haystack = `${row.label} ${row.description} ${settingsPageMeta(row.page).title}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const LAST_PAGE_KEY = 'rig-settings-last-page';

/** The page Settings last showed on this computer, or General. */
export function readLastSettingsPage(): SettingsPageId {
  try {
    const saved = localStorage.getItem(LAST_PAGE_KEY);
    return isSettingsPageId(saved) ? saved : 'general';
  } catch {
    return 'general';
  }
}

export function writeLastSettingsPage(page: SettingsPageId): void {
  try {
    localStorage.setItem(LAST_PAGE_KEY, page);
  } catch {
    // Not remembered: Settings opens on General next time, which is fine.
  }
}
