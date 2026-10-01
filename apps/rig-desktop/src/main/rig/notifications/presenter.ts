import { BUNDLE_WINDOW_MS, type RigNotification } from '@shared/rig/notifications';

/**
 * Turns rows into macOS banners (spec §5, presenter): one live banner per
 * space for ambient rows, so a burst of messages reads as "3 new messages
 * in Launch" instead of three banners; direct rows (mentions, replies, your
 * agent, requests to it, invites) always get their own.
 *
 * No Electron import: the banner itself comes from `BannerFactory`, so the
 * bundling rules are unit-tested with a fake (`presenter.test.ts`).
 */

export type BannerHandle = { close(): void };

export type BannerSpec = {
  title: string;
  subtitle?: string;
  body: string;
  silent: boolean;
  /** Fires once, when the person clicks the banner. */
  onClick: () => void;
  /** Fires when the banner goes away on its own or is dismissed. */
  onClose: () => void;
};

export type BannerFactory = (spec: BannerSpec) => BannerHandle;

type Live = {
  handle: BannerHandle;
  rows: RigNotification[];
  bindingId: string | null;
  ambient: boolean;
  shownAt: number;
};

export type PresenterOptions = {
  factory: BannerFactory;
  now: () => number;
  sound: () => boolean;
  /** A banner was clicked: every row it stood for, newest last. */
  onClick: (rows: RigNotification[]) => void;
};

export class BannerPresenter {
  private readonly live = new Set<Live>();

  constructor(private readonly opts: PresenterOptions) {}

  present(row: RigNotification): void {
    const now = this.opts.now();
    if (row.tier === 'ambient' && row.bindingId) {
      const previous = [...this.live].find(
        (l) => l.ambient && l.bindingId === row.bindingId && now - l.shownAt < BUNDLE_WINDOW_MS
      );
      if (previous) {
        this.drop(previous);
        this.show([...previous.rows, row], true, now);
        return;
      }
    }
    this.show([row], row.tier === 'ambient', now);
  }

  /** Close banners whose rows were all read elsewhere. */
  closeIds(ids: readonly string[]): void {
    const read = new Set(ids);
    for (const l of [...this.live]) if (l.rows.every((r) => read.has(r.id))) this.drop(l);
  }

  closeSpace(bindingId: string): void {
    for (const l of [...this.live]) if (l.bindingId === bindingId) this.drop(l);
  }

  closeAll(): void {
    for (const l of [...this.live]) this.drop(l);
  }

  get liveCount(): number {
    return this.live.size;
  }

  private show(rows: RigNotification[], ambient: boolean, now: number): void {
    const latest = rows[rows.length - 1]!;
    const bundled = rows.length > 1;
    const entry: Live = {
      rows,
      bindingId: latest.bindingId,
      ambient,
      shownAt: now,
      handle: { close() {} },
    };
    entry.handle = this.opts.factory({
      // The relay's titles already say where ("… in Launch").
      title: bundled ? bundleTitle(rows.length, latest.spaceName) : latest.title,
      ...(!bundled && subtitleFor(latest) ? { subtitle: subtitleFor(latest)! } : {}),
      body: bundled ? `${latest.actor.name ?? 'Someone'}: ${latest.body}` : latest.body,
      silent: !this.opts.sound(),
      onClick: () => {
        this.live.delete(entry);
        this.opts.onClick(rows);
      },
      onClose: () => {
        this.live.delete(entry);
      },
    });
    this.live.add(entry);
  }

  private drop(entry: Live): void {
    this.live.delete(entry);
    entry.handle.close();
  }
}

function bundleTitle(count: number, spaceName: string | null): string {
  return spaceName ? `${count} new messages in ${spaceName}` : `${count} new messages`;
}

/** Guests get a subtitle saying where the comment came from (spec §3, Copy). */
function subtitleFor(row: RigNotification): string | null {
  if (row.actor.kind === 'guest' && row.type === 'comment' && row.tier === 'ambient') {
    return 'Guest via a share link';
  }
  return null;
}
