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

/**
 * Zero-state composer draft cache — keyed by rig binding id.
 *
 * A zero-state tab (no message sent yet) has no `RigChatStore` of its own
 * to carry `draftText`: the eager store backing it (`chat-panel.tsx`'s
 * eager-store effect) is deliberately torn down via `rigSessionRegistry.stop`
 * the moment the panel loses this rig (navigating Home) or the zero-state
 * tab stops being active (switching tabs) — so an abandoned zero-state tab
 * never leaks a live, connecting ACP session. That teardown was also
 * silently discarding whatever the user had typed, since the composer's
 * `text` lived only in React state scoped to that one Composer instance.
 * This tiny module-level map survives the teardown: `chat-panel.tsx`'s
 * Composer reads/writes it directly whenever there is no store yet, keyed
 * by the rig's `bindingId` (there is at most one zero-state tab per rig at
 * a time, so that key is stable across the store recreating with a fresh
 * random conversation id every time).
 */
const zeroStateDrafts = new Map<string, string>();

export function getZeroStateDraft(bindingId: string): string {
  return zeroStateDrafts.get(bindingId) ?? '';
}

export function setZeroStateDraft(bindingId: string, text: string): void {
  if (text) zeroStateDrafts.set(bindingId, text);
  else zeroStateDrafts.delete(bindingId);
}

export function clearZeroStateDraft(bindingId: string): void {
  zeroStateDrafts.delete(bindingId);
}
