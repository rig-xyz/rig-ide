/**
 * Round: nitpick fix — "Good morning, Dylan." at 3PM. Root cause: the
 * briefing spine used to render pulse's own `greeting` string verbatim —
 * composed server-side, in the relay's timezone, at GENERATION time, then
 * cached for up to 3h. A salutation is a CLIENT concern (the viewer's own
 * clock, at VIEW time), not something a cached server string can ever get
 * right. Pulse's `greeting` field stays in the wire type (other consumers
 * — the web — still use it); this app just stops rendering it, composing
 * its own instead from the local clock + the account profile's name
 * (never parsed out of pulse's own string).
 *
 * (The web home has the same latent bug, relay-side — flagged, not
 * touched this round; out of scope for a rig-desktop-only fix.)
 */

export function deriveSalutation(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** First token of a display name — "Dylan Bourgeois" → "Dylan". Null in, null out (no name to draw from). */
export function firstNameOf(name: string | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

/**
 * The whole greeting line. Signed-in-with-no-profile-name degrades to the
 * salutation alone ("Good afternoon.") — never a placeholder like
 * "there"/"friend" standing in for a name that isn't known.
 */
export function composeGreeting(hour: number, firstName: string | null): string {
  const salutation = deriveSalutation(hour);
  return firstName ? `${salutation}, ${firstName}.` : `${salutation}.`;
}
