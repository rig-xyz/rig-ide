/**
 * Holds a deep link until the renderer can take it. A `rig://` link can
 * arrive before any window exists (macOS `open-url` on a cold launch, the
 * initial argv on Windows/Linux) or while the renderer is still loading, and
 * a main → renderer event sent then is simply lost. So links queue here
 * until the renderer's confirm dialog mounts and drains the inbox; from then
 * on they're delivered live. A renderer reload or a closed window puts it
 * back into queueing (`reset`).
 *
 * Holds one link, not a list: a newer link replaces an unconfirmed older
 * one, which is what the user just clicked. No Electron imports, so it's
 * unit-testable on its own; the instance lives in `./deep-link.ts`.
 */
export class DeepLinkInbox<T> {
  private pending: T | null = null;
  private ready = false;

  constructor(private readonly deliver: (item: T) => void) {}

  /** A link arrived: hand it over now if the renderer is listening, else keep it. */
  push(item: T): 'delivered' | 'queued' {
    if (this.ready) {
      this.deliver(item);
      return 'delivered';
    }
    this.pending = item;
    return 'queued';
  }

  /** The renderer is listening: returns (and clears) anything that arrived first. */
  drain(): T | null {
    this.ready = true;
    const item = this.pending;
    this.pending = null;
    return item;
  }

  /** The renderer went away (reload, window closed, dialog unmounted): queue again. */
  reset(): void {
    this.ready = false;
  }
}
