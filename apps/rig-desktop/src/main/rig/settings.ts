import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '@main/lib/logger';
import {
  DEFAULT_RIG_SETTINGS,
  DEFAULT_RIGS_RAIL_VIEW,
  RIG_SETTINGS_VERSION,
  type RigOpenTabsState,
  type RigSettings,
  type RigSettingsLegacyImport,
  type RigSettingsPatch,
  type RigsRailView,
} from '@shared/rig/settings';

/**
 * The main-owned preferences store (`persistence-design.md`'s "Preferences"
 * layer) — one schema-versioned `userData/settings.json`, atomic writes
 * (temp file + rename, so a crash mid-write can never leave a truncated
 * file), in-memory cache, and a plain in-process subscribe list (the RPC
 * layer, `main/rig/settings-controller.ts`, is what turns that into the
 * renderer-facing change event).
 *
 * Takes its file path as a constructor argument rather than resolving
 * `app.getPath('userData')` itself — that Electron dependency lives in
 * `settings-path.ts`, imported only by the real boot sequence, so this class
 * stays importable (and fully testable) in plain Node/Vitest.
 */
export class RigSettingsStore {
  private settings: RigSettings = { ...DEFAULT_RIG_SETTINGS };
  private loaded = false;
  private readonly listeners = new Set<(settings: RigSettings) => void>();

  constructor(private readonly path: string) {}

  /** Reads the file into memory. Idempotent — a no-op after the first call. */
  initialize(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.settings = readSettingsFile(this.path);
  }

  get(): RigSettings {
    return this.settings;
  }

  /**
   * Merges `patch` into the current settings, persists atomically, and
   * notifies subscribers. `lastHarnessByRig`/`lastOpenTabsByRig` merge at
   * the key level (one rig's entry) rather than replacing the whole map, so
   * two rigs' chat panels writing their own state can never clobber each
   * other.
   */
  set(patch: RigSettingsPatch): RigSettings {
    const next: RigSettings = {
      ...this.settings,
      ...patch,
      ...(patch.lastHarnessByRig
        ? { lastHarnessByRig: { ...this.settings.lastHarnessByRig, ...patch.lastHarnessByRig } }
        : {}),
      ...(patch.lastModelByHarness
        ? { lastModelByHarness: { ...this.settings.lastModelByHarness, ...patch.lastModelByHarness } }
        : {}),
      ...(patch.lastEffortByHarness
        ? { lastEffortByHarness: { ...this.settings.lastEffortByHarness, ...patch.lastEffortByHarness } }
        : {}),
      ...(patch.lastModeByHarness
        ? { lastModeByHarness: { ...this.settings.lastModeByHarness, ...patch.lastModeByHarness } }
        : {}),
      ...(patch.lastOpenTabsByRig
        ? { lastOpenTabsByRig: { ...this.settings.lastOpenTabsByRig, ...patch.lastOpenTabsByRig } }
        : {}),
    };
    this.settings = next;
    writeSettingsFile(this.path, next);
    this.notify();
    return next;
  }

  /**
   * One-time migration from renderer localStorage. Applies `legacy` only if
   * this store's file didn't exist on disk before this call — the file's
   * existence *is* the "already migrated" marker, so the renderer can call
   * this unconditionally on every boot without tracking its own "have I
   * migrated" flag.
   */
  importLegacy(legacy: RigSettingsLegacyImport): RigSettings {
    if (existsSync(this.path)) return this.settings;
    if (Object.keys(legacy).length === 0) return this.settings;
    return this.set(legacy);
  }

  subscribe(cb: (settings: RigSettings) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb(this.settings);
      } catch (error) {
        log.warn('Rig settings: a subscriber threw', { error: String(error) });
      }
    }
  }
}

function readSettingsFile(path: string): RigSettings {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No file yet — first run, or userData was cleared. Defaults are honest.
    return { ...DEFAULT_RIG_SETTINGS };
  }
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch (error) {
    log.warn('Rig settings: could not parse settings.json — using defaults', {
      error: String(error),
    });
    return { ...DEFAULT_RIG_SETTINGS };
  }
}

/** Parse-tolerant: a corrupt or hand-edited file degrades to defaults, never a crash. */
function normalizeSettings(parsed: unknown): RigSettings {
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_RIG_SETTINGS };
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== RIG_SETTINGS_VERSION) {
    // A future schema version, or corrupt — v1 is the only version that has
    // ever existed, so there is no migration path to run yet.
    return { ...DEFAULT_RIG_SETTINGS };
  }
  return {
    version: RIG_SETTINGS_VERSION,
    theme: raw.theme === 'dark' || raw.theme === 'light' ? raw.theme : null,
    chatPanelWidth: typeof raw.chatPanelWidth === 'number' ? raw.chatPanelWidth : null,
    chatPanelCollapsed: raw.chatPanelCollapsed === true,
    lastHarnessByRig: isStringRecord(raw.lastHarnessByRig) ? raw.lastHarnessByRig : {},
    lastHarness: typeof raw.lastHarness === 'string' ? raw.lastHarness : null,
    lastKnownRunnableAgents: isStringArray(raw.lastKnownRunnableAgents)
      ? raw.lastKnownRunnableAgents
      : [],
    lastModelByHarness: isStringRecord(raw.lastModelByHarness) ? raw.lastModelByHarness : {},
    lastEffortByHarness: isStringRecord(raw.lastEffortByHarness) ? raw.lastEffortByHarness : {},
    lastModeByHarness: isStringRecord(raw.lastModeByHarness) ? raw.lastModeByHarness : {},
    lastOpenTabsByRig: isOpenTabsRecord(raw.lastOpenTabsByRig) ? raw.lastOpenTabsByRig : {},
    // A FILE THAT PARSED means this isn't a first run — a pre-existing
    // settings.json that predates this field defaults it to `true`
    // (already seen), never `false`; only the "no file at all" branch in
    // `readSettingsFile` (spreading `DEFAULT_RIG_SETTINGS`) genuinely means
    // first run. An explicit boolean already in the file is always honored
    // either way.
    hasSeenOnboarding: typeof raw.hasSeenOnboarding === 'boolean' ? raw.hasSeenOnboarding : true,
    rigsRailView: isRigsRailView(raw.rigsRailView) ? raw.rigsRailView : DEFAULT_RIGS_RAIL_VIEW,
  };
}

function isRigsRailView(value: unknown): value is RigsRailView {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.filter === 'all' || v.filter === 'local' || v.filter === 'shared' || v.filter === 'notSetUp') &&
    (v.sort === 'recent' || v.sort === 'name')
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isOpenTabsState(value: unknown): value is RigOpenTabsState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.sessionIds) &&
    v.sessionIds.every((id) => typeof id === 'string') &&
    (v.activeId === null || typeof v.activeId === 'string')
  );
}

function isOpenTabsRecord(value: unknown): value is Record<string, RigOpenTabsState> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isOpenTabsState);
}

function writeSettingsFile(path: string, settings: RigSettings): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Write + rename: atomic on both POSIX and NTFS, so a crash or power loss
  // mid-write can never leave settings.json truncated or half-written.
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf8');
  renameSync(tmpPath, path);
}
