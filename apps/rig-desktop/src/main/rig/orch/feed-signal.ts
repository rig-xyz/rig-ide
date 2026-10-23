/**
 * The relay said the person's Feed changed (`feed_changed` on the
 * notification stream). Main-process listeners hear it here; the renderer
 * hears it as `rigFeedChangedChannel`.
 */
const listeners = new Set<() => void>();

export function onRelayFeedChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function relayFeedChanged(): void {
  for (const listener of listeners) listener();
}
