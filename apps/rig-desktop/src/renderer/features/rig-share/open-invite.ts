/**
 * Opens the space's invite form (the top bar's Invite pill) from anywhere,
 * such as the empty Room's "Invite someone". A window event, since the pill
 * lives in the app's top bar and the Room doesn't hold it.
 */
export const OPEN_INVITE_EVENT = 'rig:open-invite';

export function openInviteForm(): void {
  window.dispatchEvent(new CustomEvent(OPEN_INVITE_EVENT));
}

/** Calls `open` each time something asks for the invite form; returns the unsubscribe. */
export function onOpenInviteForm(open: () => void): () => void {
  window.addEventListener(OPEN_INVITE_EVENT, open);
  return () => window.removeEventListener(OPEN_INVITE_EVENT, open);
}
