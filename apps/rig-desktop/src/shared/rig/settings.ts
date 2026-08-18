import { defineEvent } from '../lib/ipc/events';

/**
 * Main-owned app preferences (`persistence-design.md`'s "Preferences" layer)
 * — a single schema-versioned `userData/settings.json`, deliberately
 * separate from Emdash's inherited `app_settings` SQLite table (design doc
 * principle 3: our own state, not woven into theirs). Renderer `localStorage`
 * is not durable enough to be the source of truth (cache-clearable,
 * partition-bound, invisible to main) — see `main/rig/settings.ts` for the
 * store and `renderer/lib/settings.ts` for the localStorage-mirror/migration
 * side of this.
 */

export const RIG_SETTINGS_VERSION = 1;

/** Which chat tabs were open for one rig, and which was active — Round D's tab restore. */
export type RigOpenTabsState = {
  /** Ordered session ids (rig_sessions.id) — restored as read-only replay views, never live. */
  sessionIds: string[];
  activeId: string | null;
};

/**
 * Round: rigs-rail filter/sort (Dylan — "I like the three dots," calmer at
 * 15+ rigs). `'shared'` mirrors `deriveRelayOnlyRowStatus`'s own role-based
 * "shared with you" test (role !== owner) — not "has a known local path,"
 * which is a DIFFERENT axis (availability, not ownership) `'notSetUp'`
 * already covers on its own.
 */
export type RigsRailFilter = 'all' | 'local' | 'shared' | 'notSetUp';
/** `'recent'` is `buildHomeRigRows`'s own existing order (local rows by recency, relay-only trailing alphabetically) — not a re-sort, just the default left alone. `'name'` re-sorts every row alphabetically regardless of kind. */
export type RigsRailSort = 'recent' | 'name';

export type RigsRailView = {
  filter: RigsRailFilter;
  sort: RigsRailSort;
};

export const DEFAULT_RIGS_RAIL_VIEW: RigsRailView = { filter: 'all', sort: 'recent' };

export type RigSettings = {
  version: 1;
  /** `null` = no explicit choice yet; the renderer falls back to system preference. */
  theme: 'dark' | 'light' | null;
  chatPanelWidth: number | null;
  chatPanelCollapsed: boolean;
  /** Binding id → provider id, so a rig's chat reopens on the harness it was last talking to. */
  lastHarnessByRig: Record<string, string>;
  /**
   * The provider id of the most recently STARTED session across all rigs —
   * the global fallback behind `lastHarnessByRig` (harness-default round:
   * a brand-new rig inherits the user's actual preference signal instead of
   * whichever agent happened to win the probe race). Written alongside the
   * per-rig entry on every session start; null until a first session ever
   * starts.
   */
  lastHarness: string | null;
  /**
   * Last KNOWN probe outcome: the agent provider ids whose runnability
   * probe most recently reported `available` (main persists this whenever
   * the live probe set changes — see `main/rig/agent-runnability.ts`).
   * Installed CLIs don't vanish between launches, so on boot these are
   * treated as available-for-DEFAULT-SELECTION immediately, while the live
   * probe re-verifies in the background and corrects the set if it changed.
   * Never used to render the picker's option list — that stays honest to
   * the live probe.
   */
  lastKnownRunnableAgents: string[];
  /**
   * Provider id → the last model/effort tier picked for that harness —
   * global (not per-rig), since "I like Sonnet on Claude" isn't a
   * per-workspace preference. Applied once, automatically, when a brand
   * new live session's model/effort options first arrive (never on a
   * resumed session, which already carries its own past choice) — see
   * `renderer/features/chat/model-preference.ts` and
   * `RigChatStore`'s own header comment on the reaction that reads these.
   */
  lastModelByHarness: Record<string, string>;
  lastEffortByHarness: Record<string, string>;
  /**
   * Round: permission-mode persistence — same shape and same auto-apply
   * path as model/effort above, with one deliberate exception: a
   * DANGEROUS mode (`isDangerousMode`, `renderer/features/chat/
   * permission-mode.ts`) is never written here. Every-session-reset stays
   * the rule for a mode that lets the agent act without asking; only a
   * SAFE pick becomes a remembered "usual preference" — see
   * `RigChatStore.setMode`'s own comment.
   */
  lastModeByHarness: Record<string, string>;
  /**
   * Binding id → open chat tabs, so "tabs should just come back" on the next
   * open of the same rig. Lives here (not a `rig_sessions` column) because
   * it's view state with its own lifecycle — which sessions are *currently
   * open in the strip* — distinct from `rig_sessions` itself (session
   * existence/persistence, Round B), the same way `lastHarnessByRig` is
   * view state and not a session-table column either.
   */
  lastOpenTabsByRig: Record<string, RigOpenTabsState>;
  /**
   * Round H2's onboarding gate. This in-memory default is only what a
   * genuinely fresh install (no settings.json at all) starts as — an
   * EXISTING settings.json that predates this field defaults it to `true`
   * on read instead (`main/rig/settings.ts`'s `normalizeSettings`), the
   * same "the file's own presence is the marker" philosophy `importLegacy`
   * already uses: an existing user must never see onboarding retroactively
   * just because this field didn't exist in their file yet.
   */
  hasSeenOnboarding: boolean;
  /** The rigs rail's own filter/sort choice — global, not per-rig (same "a plain preference" shape as `theme`, replaced wholesale on `set()`, not merged at a key level). */
  rigsRailView: RigsRailView;
};

export const DEFAULT_RIG_SETTINGS: RigSettings = {
  version: RIG_SETTINGS_VERSION,
  theme: null,
  chatPanelWidth: null,
  chatPanelCollapsed: false,
  lastHarnessByRig: {},
  lastHarness: null,
  lastKnownRunnableAgents: [],
  lastModelByHarness: {},
  lastEffortByHarness: {},
  lastModeByHarness: {},
  lastOpenTabsByRig: {},
  hasSeenOnboarding: false,
  rigsRailView: DEFAULT_RIGS_RAIL_VIEW,
};

/** The subset of legacy localStorage values the renderer can hand to `importLegacy`. */
export type RigSettingsLegacyImport = Partial<{
  theme: 'dark' | 'light';
  chatPanelWidth: number;
  chatPanelCollapsed: boolean;
}>;

/** What the renderer may actually change. `version` is main's to own. */
export type RigSettingsPatch = Partial<Omit<RigSettings, 'version'>>;

/** Broadcast on every successful `set`/`importLegacy`, carrying the new full settings. */
export const rigSettingsChangedChannel = defineEvent<RigSettings>('rig:settings-changed');
