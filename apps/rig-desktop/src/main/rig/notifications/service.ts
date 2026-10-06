import type { Result } from '@emdash/shared';
import {
  decideBanner,
  dockCount,
  EMPTY_NOTIFICATION_SUMMARY,
  type NotificationPrefs,
  type RigNotification,
  type RigNotificationSummary,
} from '@shared/rig/notifications';
import type { BannerPresenter } from './presenter';
import type { ListQuery, NotificationsRelayError, RelayContext } from './relay';
import type { SseEvent } from './sse';

/**
 * This computer's side of notifications (spec §5): keeps one stream open to
 * the relay for the signed-in account, turns new rows into banners, and
 * keeps the unread summary (Dock badge, rail badges) fresh.
 *
 * Delivery is "notice, then fetch": a stream event only says something
 * changed; rows are always read with `?after=<cursor>`, on every connect,
 * on every `notification` event, and every 60 s as a safety net for a lost
 * NOTIFY. The cursor is kept per account in rig settings, so a restart
 * never replays old banners; on an account's very first run the cursor
 * starts at its newest row, so history never floods in as banners.
 *
 * No Electron import: everything platform-specific is injected
 * (`electron.ts` wires the real thing), so the loop is unit-tested.
 */

export type NotificationServiceDeps = {
  context: () => Promise<Result<RelayContext, NotificationsRelayError>>;
  selfUserId: () => Promise<string | null>;
  list: (q: ListQuery) => Promise<Result<RigNotification[], NotificationsRelayError>>;
  summary: () => Promise<Result<RigNotificationSummary, NotificationsRelayError>>;
  stream: (
    url: string,
    token: string,
    onEvent: (e: SseEvent) => void,
    opts: { signal: AbortSignal; idleTimeoutMs: number }
  ) => Promise<void>;
  presenter: BannerPresenter;
  setBadge: (count: number) => void;
  emitChanged: (reason: 'notification' | 'read' | 'prefs' | 'connected') => void;
  prefs: () => NotificationPrefs;
  cursor: { get: (account: string) => string | null; set: (account: string, id: string) => void };
  appFocused: () => boolean;
  /** You're at another of your Macs (`active-mac.ts`); absent: never. */
  usingAnotherMac?: () => boolean;
  /** Marks rows read on the relay (the bell's own call). */
  markRead: (ids: string[]) => Promise<unknown>;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: { warn: (msg: string, meta?: Record<string, unknown>) => void };
};

const PAGE = 100;
const POLL_MS = 60_000;
const SIGNED_OUT_RETRY_MS = 30_000;
const IDLE_TIMEOUT_MS = 75_000;
const SUMMARY_DEBOUNCE_MS = 300;

export function reconnectDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** attempt);
}

export class NotificationService {
  private abort: AbortController | null = null;
  private account: string | null = null;
  private summaryCache: RigNotificationSummary = EMPTY_NOTIFICATION_SUMMARY;
  private viewing: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: NotificationServiceDeps) {}

  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    void this.run(this.abort.signal);
    this.pollTimer = setInterval(() => {
      if (!this.account) return;
      void this.catchUp();
      this.scheduleSummary();
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  /**
   * Signed in, out, or as someone else: drop everything about the previous
   * account (banners, badge, summary, its open stream) and start over with
   * whoever is signed in now. The stream would otherwise keep the old
   * token's connection until it happened to drop.
   */
  restart(): void {
    this.stop();
    this.start();
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.pollTimer = null;
    this.summaryTimer = null;
    this.signedOut();
  }

  summary(): RigNotificationSummary {
    return this.summaryCache;
  }

  /** The renderer says which space is on screen (`null`: none). */
  setViewing(bindingId: string | null): void {
    this.viewing = bindingId;
    if (bindingId) this.deps.presenter.closeSpace(bindingId);
  }

  /** Prefs changed locally: the badge may have to appear or go. */
  prefsChanged(): void {
    this.applyBadge();
  }

  /** Re-read the summary now (after this app marked something read, say). */
  refresh(): void {
    this.scheduleSummary();
  }

  private async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      const ctx = await this.deps.context();
      // A restart (another account) may land during any await: a stale
      // loop never touches the service's state again.
      if (signal.aborted) return;
      if (!ctx.success) {
        if (ctx.error.kind === 'notSignedIn') this.signedOut();
        await this.deps.sleep(ctx.error.kind === 'notSignedIn' ? SIGNED_OUT_RETRY_MS : reconnectDelayMs(attempt++), signal);
        continue;
      }
      const account = await this.deps.selfUserId();
      if (signal.aborted) return;
      if (!account) {
        await this.deps.sleep(reconnectDelayMs(attempt++), signal);
        continue;
      }
      if (this.account && this.account !== account) this.signedOut();
      this.account = account;
      // Summary first: the banner decision needs each space's level.
      await this.refreshSummary();
      await this.catchUp();
      if (signal.aborted) return;
      this.deps.emitChanged('connected');
      try {
        await this.deps.stream(
          new URL('/v1/me/notifications/stream', ctx.data.url).toString(),
          ctx.data.token,
          (e) => this.onEvent(e),
          { signal, idleTimeoutMs: IDLE_TIMEOUT_MS }
        );
        attempt = 0;
      } catch (error) {
        if (signal.aborted) return;
        this.deps.log.warn('notifications: stream dropped', { error: String(error) });
      }
      await this.deps.sleep(reconnectDelayMs(attempt++), signal);
    }
  }

  private onEvent(e: SseEvent): void {
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(e.data || '{}');
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
    } catch {
      // a malformed event is only a hint; the next catch-up covers it
    }
    if (e.event === 'notification') {
      void this.catchUp();
      this.scheduleSummary();
    } else if (e.event === 'read') {
      if (data.all === true) this.deps.presenter.closeAll();
      else if (Array.isArray(data.ids)) this.deps.presenter.closeIds(data.ids.filter((x): x is string => typeof x === 'string'));
      else if (typeof data.bindingId === 'string') this.deps.presenter.closeSpace(data.bindingId);
      this.scheduleSummary();
    } else if (e.event === 'prefs') {
      this.scheduleSummary();
    }
  }

  /** Fetch rows past the cursor and present them, one catch-up at a time. */
  catchUp(): Promise<void> {
    this.chain = this.chain.then(() => this.catchUpNow()).catch((error: unknown) => {
      this.deps.log.warn('notifications: catch-up failed', { error: String(error) });
    });
    return this.chain;
  }

  private async catchUpNow(): Promise<void> {
    const account = this.account;
    if (!account) return;
    let cursor = this.deps.cursor.get(account);
    if (cursor === null) {
      const newest = await this.deps.list({ limit: 1 });
      if (!newest.success) return;
      this.deps.cursor.set(account, newest.data[0]?.id ?? '0');
      return;
    }
    // Rows about the space on screen, seen as they arrive: read at once, so
    // the bell and the Dock don't count what you just watched happen. A run
    // finishing posts no new message, so the Room's read marker never moves
    // for it; this covers that and any other row without one.
    const seen: string[] = [];
    try {
      for (;;) {
        const page = await this.deps.list({ after: cursor, limit: PAGE });
        if (!page.success || this.account !== account) return;
        for (const row of page.data) {
          cursor = row.id;
          this.deps.cursor.set(account, row.id);
          if (this.seenOnScreen(row)) seen.push(row.id);
          else this.consider(row);
        }
        if (page.data.length < PAGE) return;
      }
    } finally {
      if (seen.length > 0 && this.account === account) {
        await this.deps.markRead(seen);
        void this.refreshSummary();
      }
    }
  }

  /** Unread, about the space in a focused window, and arrived while it was there. */
  private seenOnScreen(row: RigNotification): boolean {
    return !row.readAt && !!row.bindingId && row.bindingId === this.viewing && this.deps.appFocused();
  }

  private consider(row: RigNotification): void {
    const level = row.bindingId
      ? this.summaryCache.spaces.find((s) => s.bindingId === row.bindingId)?.level
      : undefined;
    const decision = decideBanner(row, {
      prefs: this.deps.prefs(),
      level,
      appFocused: this.deps.appFocused(),
      viewingBindingId: this.viewing,
      usingAnotherMac: this.deps.usingAnotherMac?.() ?? false,
      now: this.deps.now(),
    });
    if (decision.show) this.deps.presenter.present(row);
  }

  private scheduleSummary(): void {
    if (this.summaryTimer) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null;
      void this.refreshSummary();
    }, SUMMARY_DEBOUNCE_MS);
    this.summaryTimer.unref?.();
  }

  async refreshSummary(): Promise<void> {
    const account = this.account;
    if (!account) return;
    const res = await this.deps.summary();
    if (!res.success || this.account !== account) return;
    this.summaryCache = res.data;
    this.applyBadge();
    this.deps.emitChanged('notification');
  }

  private applyBadge(): void {
    this.deps.setBadge(this.deps.prefs().dockBadge ? dockCount(this.summaryCache) : 0);
  }

  private signedOut(): void {
    this.account = null;
    this.summaryCache = EMPTY_NOTIFICATION_SUMMARY;
    this.deps.presenter.closeAll();
    this.deps.setBadge(0);
    // The renderer drops its counts and Activity too.
    this.deps.emitChanged('read');
  }
}
