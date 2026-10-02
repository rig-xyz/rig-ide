import {
  applyHomeLayoutActions,
  DEFAULT_HOME_LAYOUT,
  type HomeLayout,
  type HomeLayoutAction,
} from '@shared/rig/home-layout';

/**
 * Keeps Home's layout in step with the relay (`GET/PUT /v1/me/home-layout`)
 * while every edit shows at once. No Electron, database or network here:
 * those come in as `HomeLayoutSyncDeps` (`home-layout.ts` wires the real
 * ones), so this is unit-tested on its own.
 *
 * State is the relay's last copy (`base`, with its `version`) plus the
 * edits made since (`pending`, as actions). What Home shows is `base` with
 * `pending` replayed on top. Both are cached on disk for this account, so a
 * relaunch offline still shows the person's layout and still saves their
 * offline edits later.
 *
 * Saving puts `base + pending` on `base.version`. If another computer saved
 * first (409), its copy becomes `base` and the same edits are replayed on
 * it, then put again: nobody's change is lost to a blind overwrite.
 */

export type SyncedLayout = { layout: HomeLayout; version: number };

export type HomeLayoutCache = { base: SyncedLayout; pending: HomeLayoutAction[] };

export type HomeLayoutGetResult = { kind: 'ok'; synced: SyncedLayout } | { kind: 'failed' };

export type HomeLayoutPutResult =
  | { kind: 'saved'; synced: SyncedLayout }
  | { kind: 'conflict'; synced: SyncedLayout }
  /** The relay refused the shape for good (400/413): retrying the same edits can't succeed. */
  | { kind: 'rejected' }
  /** Unreachable, signed out, or a server error: keep the edits and try later. */
  | { kind: 'failed' };

export type HomeLayoutSyncDeps = {
  relay: {
    get(): Promise<HomeLayoutGetResult>;
    put(layout: HomeLayout, version: number): Promise<HomeLayoutPutResult>;
  };
  store: {
    /** Who the cache belongs to right now (account and relay), or null when signed out. */
    account(): Promise<string | null>;
    read(account: string): Promise<HomeLayoutCache | null>;
    write(account: string, cache: HomeLayoutCache): Promise<void>;
  };
  /** Tells Home what to show now. */
  emit(layout: HomeLayout): void;
  /** Runs `fn` after `ms`; returns a cancel. */
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
};

export const SAVE_DELAY_MS = 300;
export const RETRY_DELAY_MS = 30_000;
export const REFRESH_EVERY_MS = 30_000;
const CONFLICT_RETRIES = 3;

const EMPTY: HomeLayoutCache = { base: { layout: DEFAULT_HOME_LAYOUT, version: 0 }, pending: [] };

export class HomeLayoutSync {
  private account: string | null = null;
  private cache: HomeLayoutCache = EMPTY;
  private loaded = false;
  /** Bumped on every account switch, so a save or fetch begun for the last account can't land in this one. */
  private generation = 0;
  private saving: Promise<void> | null = null;
  private saveAgain = false;
  private cancelTimer: (() => void) | null = null;
  private lastRefreshAt = -Infinity;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: HomeLayoutSyncDeps) {}

  /** What Home shows: the cached layout at once, refreshed from the relay in the background when it's been a while. */
  async get(): Promise<HomeLayout> {
    await this.ensureAccount();
    if (this.deps.now() - this.lastRefreshAt >= REFRESH_EVERY_MS) void this.refresh();
    return this.displayed();
  }

  /** Applies one edit now and saves it shortly (edits made close together go up as one save). */
  async apply(action: HomeLayoutAction): Promise<HomeLayout> {
    await this.ensureAccount();
    this.cache = { ...this.cache, pending: [...this.cache.pending, action] };
    await this.persist();
    this.scheduleSave(SAVE_DELAY_MS);
    return this.displayed();
  }

  /** Reads the relay's copy; edits not yet saved are replayed on top of it. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** Saves any edits not yet on the relay. Resolves once this round is done (tests and shutdown). */
  async flush(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    this.saving = this.save().finally(() => {
      this.saving = null;
      if (this.saveAgain) {
        this.saveAgain = false;
        void this.flush();
      }
    });
    return this.saving;
  }

  displayed(): HomeLayout {
    return applyHomeLayoutActions(this.cache.base.layout, this.cache.pending);
  }

  private async ensureAccount(): Promise<void> {
    const account = await this.deps.store.account();
    if (this.loaded && account === this.account) return;
    this.generation += 1;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.account = account;
    this.lastRefreshAt = -Infinity;
    this.cache = (account ? await this.deps.store.read(account).catch(() => null) : null) ?? EMPTY;
    this.loaded = true;
    // Edits saved offline last time go up now.
    if (this.cache.pending.length > 0) this.scheduleSave(0);
  }

  private async persist(): Promise<void> {
    if (!this.account) return;
    await this.deps.store.write(this.account, this.cache).catch(() => undefined);
  }

  private scheduleSave(ms: number): void {
    this.cancelTimer?.();
    this.cancelTimer = this.deps.schedule(() => {
      this.cancelTimer = null;
      void this.flush();
    }, ms);
  }

  private async doRefresh(): Promise<void> {
    await this.ensureAccount();
    const generation = this.generation;
    const before = JSON.stringify(this.displayed());
    const result = await this.deps.relay.get();
    if (generation !== this.generation || result.kind !== 'ok') return;
    this.lastRefreshAt = this.deps.now();
    // A copy older than the one already held (a save landed meanwhile) changes nothing.
    if (result.synced.version < this.cache.base.version) return;
    this.cache = { ...this.cache, base: result.synced };
    await this.persist();
    if (JSON.stringify(this.displayed()) !== before) this.deps.emit(this.displayed());
    if (this.cache.pending.length > 0) await this.flush();
  }

  private async save(): Promise<void> {
    const generation = this.generation;
    for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt++) {
      const sent = this.cache.pending.length;
      if (sent === 0) return;
      const before = JSON.stringify(this.displayed());
      const next = applyHomeLayoutActions(
        this.cache.base.layout,
        this.cache.pending.slice(0, sent)
      );
      const result = await this.deps.relay.put(next, this.cache.base.version);
      if (generation !== this.generation) return;
      switch (result.kind) {
        case 'saved':
          // Edits made while the save was in flight stay pending, on top of the new copy.
          this.cache = { base: result.synced, pending: this.cache.pending.slice(sent) };
          await this.persist();
          if (this.cache.pending.length > 0) this.scheduleSave(SAVE_DELAY_MS);
          return;
        case 'conflict':
          this.cache = { ...this.cache, base: result.synced };
          await this.persist();
          if (JSON.stringify(this.displayed()) !== before) this.deps.emit(this.displayed());
          continue;
        case 'rejected':
          this.cache = { ...this.cache, pending: this.cache.pending.slice(sent) };
          await this.persist();
          this.deps.emit(this.displayed());
          return;
        case 'failed':
          this.scheduleSave(RETRY_DELAY_MS);
          return;
      }
    }
    this.scheduleSave(RETRY_DELAY_MS);
  }
}
