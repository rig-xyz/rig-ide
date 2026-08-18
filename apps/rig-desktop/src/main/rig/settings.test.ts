import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RIG_SETTINGS } from '@shared/rig/settings';
import { RigSettingsStore } from './settings';

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rig-settings-'));
  settingsPath = join(dir, 'nested', 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RigSettingsStore', () => {
  it('returns defaults before initialize() and when no file exists yet', () => {
    const store = new RigSettingsStore(settingsPath);
    expect(store.get()).toEqual(DEFAULT_RIG_SETTINGS);
    store.initialize();
    expect(store.get()).toEqual(DEFAULT_RIG_SETTINGS);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('persists a set() to disk and reflects it in get()', () => {
    const store = new RigSettingsStore(settingsPath);
    store.initialize();

    const next = store.set({ theme: 'dark', chatPanelWidth: 320 });

    expect(next.theme).toBe('dark');
    expect(next.chatPanelWidth).toBe(320);
    expect(store.get()).toEqual(next);

    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(onDisk).toEqual(next);
  });

  it('creates the parent directory (settings.json need not pre-exist)', () => {
    const store = new RigSettingsStore(settingsPath);
    store.initialize();
    store.set({ theme: 'light' });
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('leaves no temp files behind after a write', () => {
    const store = new RigSettingsStore(settingsPath);
    store.initialize();
    store.set({ theme: 'dark' });
    const entries = readdirSync(join(dir, 'nested'));
    expect(entries).toEqual(['settings.json']);
  });

  it('a second store instance reads back what the first one wrote', () => {
    const first = new RigSettingsStore(settingsPath);
    first.initialize();
    first.set({ chatPanelCollapsed: true });

    const second = new RigSettingsStore(settingsPath);
    second.initialize();
    expect(second.get().chatPanelCollapsed).toBe(true);
  });

  it('merges lastHarnessByRig at the key level rather than replacing the map', () => {
    const store = new RigSettingsStore(settingsPath);
    store.initialize();
    store.set({ lastHarnessByRig: { 'binding-1': 'claude' } });
    store.set({ lastHarnessByRig: { 'binding-2': 'codex' } });

    expect(store.get().lastHarnessByRig).toEqual({
      'binding-1': 'claude',
      'binding-2': 'codex',
    });
  });

  it('merges lastModelByHarness/lastEffortByHarness/lastModeByHarness at the key level — one harness writing its pick never clobbers another', () => {
    const store = new RigSettingsStore(settingsPath);
    store.initialize();
    store.set({ lastModelByHarness: { claude: 'sonnet' } });
    store.set({ lastModelByHarness: { codex: 'gpt-5' } });
    store.set({ lastEffortByHarness: { claude: 'high' } });
    store.set({ lastEffortByHarness: { codex: 'medium' } });
    store.set({ lastModeByHarness: { claude: 'acceptEdits' } });
    store.set({ lastModeByHarness: { codex: 'read-only' } });

    expect(store.get().lastModelByHarness).toEqual({ claude: 'sonnet', codex: 'gpt-5' });
    expect(store.get().lastEffortByHarness).toEqual({ claude: 'high', codex: 'medium' });
    expect(store.get().lastModeByHarness).toEqual({ claude: 'acceptEdits', codex: 'read-only' });
  });

  it('an existing settings.json that predates lastModelByHarness/lastEffortByHarness/lastModeByHarness degrades all three to empty maps, not a throw', () => {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, theme: null, chatPanelWidth: null, chatPanelCollapsed: false, lastHarnessByRig: {}, lastOpenTabsByRig: {} })
    );
    const store = new RigSettingsStore(settingsPath);
    expect(() => store.initialize()).not.toThrow();
    expect(store.get().lastModelByHarness).toEqual({});
    expect(store.get().lastEffortByHarness).toEqual({});
    expect(store.get().lastModeByHarness).toEqual({});
  });

  it('merges lastOpenTabsByRig at the key level — one rig writing its tabs never clobbers another', () => {
    const store = new RigSettingsStore(settingsPath);
    store.initialize();
    store.set({ lastOpenTabsByRig: { 'binding-1': { sessionIds: ['s1', 's2'], activeId: 's1' } } });
    store.set({ lastOpenTabsByRig: { 'binding-2': { sessionIds: ['s3'], activeId: 's3' } } });

    expect(store.get().lastOpenTabsByRig).toEqual({
      'binding-1': { sessionIds: ['s1', 's2'], activeId: 's1' },
      'binding-2': { sessionIds: ['s3'], activeId: 's3' },
    });
  });

  it('overwrites a rig own entry wholesale on a repeat write for that rig', () => {
    const store = new RigSettingsStore(settingsPath);
    store.initialize();
    store.set({ lastOpenTabsByRig: { 'binding-1': { sessionIds: ['s1', 's2'], activeId: 's1' } } });
    store.set({ lastOpenTabsByRig: { 'binding-1': { sessionIds: ['s2'], activeId: 's2' } } });

    expect(store.get().lastOpenTabsByRig['binding-1']).toEqual({ sessionIds: ['s2'], activeId: 's2' });
  });

  it('degrades a corrupt lastOpenTabsByRig entry to an empty map rather than throwing', () => {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...DEFAULT_RIG_SETTINGS,
        lastOpenTabsByRig: { 'binding-1': { sessionIds: 'not-an-array' } },
      })
    );
    const store = new RigSettingsStore(settingsPath);
    expect(() => store.initialize()).not.toThrow();
    expect(store.get().lastOpenTabsByRig).toEqual({});
  });

  it('does not touch unrelated keys on a partial set()', () => {
    const store = new RigSettingsStore(settingsPath);
    store.initialize();
    store.set({ theme: 'dark', chatPanelWidth: 280 });
    store.set({ theme: 'light' });

    expect(store.get()).toMatchObject({ theme: 'light', chatPanelWidth: 280 });
  });

  describe('hasSeenOnboarding grandfathering (round H2)', () => {
    it('a brand-new install (no file at all) starts false — the one genuine first run', () => {
      const store = new RigSettingsStore(settingsPath);
      store.initialize();
      expect(store.get().hasSeenOnboarding).toBe(false);
    });

    it('an existing settings.json that predates this field defaults it to true, not false', () => {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ version: 1, theme: 'dark', chatPanelWidth: null, chatPanelCollapsed: false, lastHarnessByRig: {}, lastOpenTabsByRig: {} })
      );
      const store = new RigSettingsStore(settingsPath);
      store.initialize();
      expect(store.get().hasSeenOnboarding).toBe(true);
    });

    it('an explicit false already on disk is honored, not upgraded to true', () => {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ ...DEFAULT_RIG_SETTINGS, hasSeenOnboarding: false }));
      const store = new RigSettingsStore(settingsPath);
      store.initialize();
      expect(store.get().hasSeenOnboarding).toBe(false);
    });

    it('set({ hasSeenOnboarding: true }) persists and round-trips', () => {
      const store = new RigSettingsStore(settingsPath);
      store.initialize();
      store.set({ hasSeenOnboarding: true });

      const second = new RigSettingsStore(settingsPath);
      second.initialize();
      expect(second.get().hasSeenOnboarding).toBe(true);
    });
  });

  describe('rigsRailView (round 2 — filter/sort persistence)', () => {
    it('defaults to all/recent before anything is ever set', () => {
      const store = new RigSettingsStore(settingsPath);
      store.initialize();
      expect(store.get().rigsRailView).toEqual({ filter: 'all', sort: 'recent' });
    });

    it('set() persists and round-trips through a second store instance', () => {
      const first = new RigSettingsStore(settingsPath);
      first.initialize();
      first.set({ rigsRailView: { filter: 'local', sort: 'name' } });

      const second = new RigSettingsStore(settingsPath);
      second.initialize();
      expect(second.get().rigsRailView).toEqual({ filter: 'local', sort: 'name' });
    });

    it('an existing settings.json that predates this field degrades to the default, not a throw', () => {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ version: 1, theme: null, chatPanelWidth: null, chatPanelCollapsed: false, lastHarnessByRig: {}, lastOpenTabsByRig: {} })
      );
      const store = new RigSettingsStore(settingsPath);
      expect(() => store.initialize()).not.toThrow();
      expect(store.get().rigsRailView).toEqual({ filter: 'all', sort: 'recent' });
    });

    it('a malformed value (bad filter/sort strings) degrades to the default rather than passing through', () => {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({ ...DEFAULT_RIG_SETTINGS, rigsRailView: { filter: 'bogus', sort: 'name' } })
      );
      const store = new RigSettingsStore(settingsPath);
      store.initialize();
      expect(store.get().rigsRailView).toEqual({ filter: 'all', sort: 'recent' });
    });

    it('replaces wholesale on set() — not merged at a key level (it is not a per-rig map)', () => {
      const store = new RigSettingsStore(settingsPath);
      store.initialize();
      store.set({ rigsRailView: { filter: 'shared', sort: 'recent' } });
      store.set({ rigsRailView: { filter: 'all', sort: 'name' } });

      expect(store.get().rigsRailView).toEqual({ filter: 'all', sort: 'name' });
    });
  });

  it('degrades a corrupt settings.json to defaults instead of throwing', () => {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(settingsPath, 'not json');

    const store = new RigSettingsStore(settingsPath);
    expect(() => store.initialize()).not.toThrow();
    expect(store.get()).toEqual(DEFAULT_RIG_SETTINGS);
  });

  it('notifies subscribers on set(), and stops after unsubscribe', () => {
    const store = new RigSettingsStore(settingsPath);
    store.initialize();

    const seen: boolean[] = [];
    const unsubscribe = store.subscribe((settings) => {
      seen.push(settings.chatPanelCollapsed);
    });

    store.set({ chatPanelCollapsed: true });
    unsubscribe();
    store.set({ chatPanelCollapsed: false });

    expect(seen).toEqual([true]);
  });

  describe('importLegacy', () => {
    it('applies legacy values when no settings file exists yet', () => {
      const store = new RigSettingsStore(settingsPath);
      store.initialize();

      const next = store.importLegacy({ theme: 'dark', chatPanelWidth: 300 });

      expect(next.theme).toBe('dark');
      expect(next.chatPanelWidth).toBe(300);
      expect(existsSync(settingsPath)).toBe(true);
    });

    it('is a no-op once a settings file already exists (idempotent across boots)', () => {
      const store = new RigSettingsStore(settingsPath);
      store.initialize();
      store.set({ theme: 'light' });

      const next = store.importLegacy({ theme: 'dark' });

      expect(next.theme).toBe('light');
    });

    it('does not write a file when there is nothing to import', () => {
      const store = new RigSettingsStore(settingsPath);
      store.initialize();
      store.importLegacy({});
      expect(existsSync(settingsPath)).toBe(false);
    });
  });
});
