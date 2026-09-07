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
 * already covers on its own. `'hidden'` (Hide/Unhide round) is the one view
 * that INCLUDES hidden rows on purpose — every other filter excludes them,
 * see `filterHomeRigRows`.
 */
export type RigsRailFilter = 'all' | 'local' | 'shared' | 'notSetUp' | 'hidden';
/** `'recent'` is `buildHomeRigRows`'s own existing order (local rows by recency, relay-only trailing alphabetically) — not a re-sort, just the default left alone. `'name'` re-sorts every row alphabetically regardless of kind. */
export type RigsRailSort = 'recent' | 'name';

export type RigsRailView = {
  filter: RigsRailFilter;
  sort: RigsRailSort;
};

export const DEFAULT_RIGS_RAIL_VIEW: RigsRailView = { filter: 'all', sort: 'recent' };

/**
 * File-navigator redesign (§5, working-set sort + filters; renamed/re-specced
 * §3.4 in the v2 round): the file tree's own sort/filter choice, per rig
 * (unlike `rigsRailView` above, a person's taste for "what am I working on"
 * genuinely differs rig to rig). `'smart'` is the default — frecency
 * blending the user's own opens with file change times plus an unseen boost
 * (`shared/rig/tree-view.ts`'s `frecencyScore`/`UNSEEN_BOOST`, pure and
 * tested), content-only by construction. `'modified'`/`'name'` are the old
 * `'newest'`/`'alphabetical'` renamed to match the header dropdown's own
 * labels exactly (§3.1). The old standalone `'unseenFirst'` mode is gone —
 * folded into Smart's boost instead.
 */
export type FileTreeSort = 'smart' | 'modified' | 'name';
/**
 * §3.1: the header's old All/Agents/Unseen radio group is gone — "Changed by
 * agents" now surfaces as reasons inside Suggested, not as a tree filter, so
 * `'agents'` is gone too. `'unseen'` is what the header's contextual "N new"
 * chip toggles into.
 */
export type FileTreeFilter = 'all' | 'unseen';

export type FileTreeView = {
  sort: FileTreeSort;
  filter: FileTreeFilter;
};

export const DEFAULT_FILE_TREE_VIEW: FileTreeView = { sort: 'smart', filter: 'all' };

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
  /**
   * Round: make app updates visible. ms epoch of the last time a version
   * check genuinely RESOLVED (found an update, or confirmed none) —
   * written by `main/core/updates/update-service.ts` itself, not the
   * renderer, so "checked Xh ago" survives a relaunch honestly even if
   * Settings → About was never opened this session. `null` until the
   * first check this install has ever completed.
   */
  updateLastCheckedAt: number | null;
  /**
   * The version string of the last downloaded-and-ready update the "Rig
   * X is ready" toast already announced — so a relaunch (or a second
   * mount of the toast watcher) never re-shows it for the SAME version,
   * while a genuinely newer one downloaded later still gets its own
   * toast. `null` until the first update this install has ever announced.
   */
  updateAnnouncedVersion: string | null;
  /**
   * Hide round: a rig row hidden from the rail's normal views — purely a
   * local display preference (no relay call, nothing touched on disk for
   * the rig itself), same "bindingId-keyed map" shape as `lastHarnessByRig`/
   * `lastOpenTabsByRig` above, merged at the key level on `set()` for the
   * same reason those are: one rig's hide/unhide must never clobber
   * another's. Absence of a key (not just `false`) means "not hidden" —
   * `filterHomeRigRows` treats both the same way.
   */
  hiddenByRig: Record<string, boolean>;
  /**
   * File-navigator redesign (`docs/file-navigator-design.md` §1): the tree's
   * "Show system files" toggle — `rig.toml`, `.rig/`, and other dotfiles/
   * dot-dirs are hidden by default. Same "plain global preference, replaced
   * wholesale" shape as `theme`/`rigsRailView` above, not per-rig — a
   * reader's taste for seeing system files isn't scoped to one workspace.
   */
  showSystemFiles: boolean;
  /**
   * File-navigator redesign (§3, card rail): user-pinned file paths, per rig
   * — an ordered list (pin order, most-recently-pinned last), same
   * bindingId-keyed shape as `hiddenByRig`/`lastOpenTabsByRig` above, merged
   * at the key level on `set()` for the same reason those are.
   */
  pinnedPathsByRig: Record<string, string[]>;
  /** File-navigator redesign (§5): the tree's own sort/filter choice, per rig — see `FileTreeView`'s own comment. */
  fileTreeViewByRig: Record<string, FileTreeView>;
  /**
   * Comment-agent permission relay: when true, every tool-call permission a
   * headless `@mention` turn raises is resolved immediately with its plain
   * `allow_once` option (never the provider's `allow_always`) instead of
   * being posted to the thread — see `main/rig/comment-agent.ts`'s
   * `publishPermissions`. A plain global preference, replaced wholesale on
   * `set()`, not merged — same shape as `theme`/`showSystemFiles` above, not
   * per-rig: this is a machine-wide risk tradeoff, not a workspace taste.
   * Default `false` — comment text arrives from collaborators and is
   * untrusted, so an agent acting on it without asking is opt-in only. See
   * `main/rig/comment-agent-auto-approve.ts`'s existing read-only `rig
   * context` auto-approve, which stays active regardless of this setting.
   */
  autoApproveAgentActions: boolean;
  /**
   * Paintbrush (`renderer/features/docs/paintbrush`): the provider id last
   * chosen in the header's agent dropdown — a plain global preference,
   * replaced wholesale on `set()`, same shape as `lastHarness` above (not
   * per-rig: which agent someone reaches for to edit inline isn't a
   * workspace taste). `null` until the reader ever opens the dropdown.
   * Deliberately separate from `lastHarness`/`lastHarnessByRig`, which are
   * the CHAT panel's own harness memory — paintbrush mode itself (on/off)
   * is per-window UI state and is never persisted here at all.
   */
  paintbrushAgent: string | null;
  /**
   * Discoverability round (punch-list finding 4): whether the first-use
   * coach mark ("Paintbrush is on. Select any text...") has already been
   * shown once, ever — a plain global preference through the SAME
   * persistence mechanism as `paintbrushAgent` above (`rpc.rig.settings`),
   * not per-rig: seeing the mode explained once is enough regardless of
   * which rig it happened in. `false` until the mode is ever turned on.
   */
  paintbrushCoachMarkSeen: boolean;
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
  updateLastCheckedAt: null,
  updateAnnouncedVersion: null,
  hiddenByRig: {},
  showSystemFiles: false,
  pinnedPathsByRig: {},
  fileTreeViewByRig: {},
  autoApproveAgentActions: false,
  paintbrushAgent: null,
  paintbrushCoachMarkSeen: false,
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
