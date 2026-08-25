/**
 * Owns renderer chat sessions independently from the view that is currently
 * displaying them. A panel can disappear while its ACP session continues to
 * run, then attach to the same store when the rig is shown again.
 *
 * The registry intentionally knows nothing about React (or about live versus
 * replay sessions). Callers provide the factory for a missing conversation;
 * this keeps construction injectable in tests and lets the panel choose the
 * appropriate store for a restored tab.
 */

export interface RigSessionStore {
  readonly conversationId: string;
  dispose(): void | PromiseLike<void>;
}

type RegistryEntry<Store extends RigSessionStore> = {
  store: Store;
};

type SessionFactory<Store extends RigSessionStore> = () => Store;

export class RigSessionRegistry<Store extends RigSessionStore> {
  private readonly entries = new Map<string, RegistryEntry<Store>>();

  constructor(private readonly defaultFactory?: SessionFactory<Store>) {}

  /** Return the existing store, or create and retain one for this id. */
  attach<T extends Store>(conversationId: string, factory?: SessionFactory<T>): T {
    const existing = this.entries.get(conversationId);
    if (existing) return existing.store as T;

    const create = factory ?? (this.defaultFactory as SessionFactory<T> | undefined);
    if (!create) throw new Error(`No factory was provided for rig session ${conversationId}`);
    const store = create();
    if (store.conversationId !== conversationId) {
      throw new Error(`Rig session factory returned ${store.conversationId} for ${conversationId}`);
    }
    this.entries.set(conversationId, { store });
    return store;
  }

  get<T extends Store>(conversationId: string): T | null {
    return (this.entries.get(conversationId)?.store as T | undefined) ?? null;
  }

  /**
   * Release a view's attachment without stopping the underlying session.
   * The entry remains available for a later panel mount.
   */
  detach(conversationId: string): void {
    // Keeping this operation explicit makes lifecycle intent visible at the
    // call site. Session ownership remains in `entries` by design.
    if (!this.entries.has(conversationId)) return;
  }

  /**
   * Stop a session exactly once. Removing the entry before invoking dispose
   * also makes concurrent/re-entrant stop calls harmless.
   */
  async stop(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    this.entries.delete(conversationId);
    await entry.store.dispose();
  }

  /**
   * Stop every retained session, but do not let one hanging disposer hold up
   * renderer shutdown forever. Stores are removed synchronously by `stop`
   * before their disposer is awaited.
   */
  async stopAll(reason: string, timeoutMs = 1_000): Promise<void> {
    void reason;
    const stopping = Promise.allSettled(
      [...this.entries.keys()].map((conversationId) => this.stop(conversationId))
    );
    if (timeoutMs <= 0) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([stopping.then(() => undefined), bounded]);
    if (timeout !== undefined) clearTimeout(timeout);
  }

  getActiveSessions<T extends Store = Store>(): T[] {
    return [...this.entries.values()].map(({ store }) => store as T);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Process-local ownership for all rig chat panels. */
export const rigSessionRegistry = new RigSessionRegistry<RigSessionStore>();
