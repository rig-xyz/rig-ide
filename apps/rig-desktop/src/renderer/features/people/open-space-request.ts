import type { OpenSpaceAt } from '@shared/rig/notifications';

/**
 * A renderer-only way to ask App to open a space (the person card's shared
 * spaces), through the same `openSpaceAt` a notification click uses,
 * without threading a callback through every surface that shows a person.
 */
const EVENT = 'rig:request-open-space';

export function requestOpenSpace(target: OpenSpaceAt): void {
  window.dispatchEvent(new CustomEvent<OpenSpaceAt>(EVENT, { detail: target }));
}

export function onOpenSpaceRequest(handler: (target: OpenSpaceAt) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<OpenSpaceAt>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
