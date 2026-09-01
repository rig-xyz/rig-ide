/** Minimal shape shared by Wire replicas without coupling tests to the runtime. */
export type AsyncDisposable = { dispose: () => Promise<void> };

/**
 * A live topic may disappear between its ready rejection and cleanup. Disposal
 * is best-effort in that race and must never become an unhandled rejection —
 * main intentionally exits on any unhandled promise.
 */
export async function disposeReplicaSafely(replica: AsyncDisposable): Promise<void> {
  try {
    await replica.dispose();
  } catch {
    // The remote topic is already gone, which is the state cleanup wanted.
  }
}
