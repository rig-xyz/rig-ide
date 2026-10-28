/**
 * What the first run hands Home as it ends: that Home is arriving from it
 * (it fades in rather than cutting), and the session a card just started,
 * which lands in its place in the rail once the rail has it. Shown once.
 */

export type HomeArrival = {
  /** The session a card started, to land in the rail. */
  sessionId?: string;
};

let pending: HomeArrival | null = null;

/** The first run is ending into Home. */
export function arriveHome(arrival: HomeArrival = {}): void {
  pending = arrival;
}

/** The arrival Home is still to show; null when it didn't come from the first run, or showed it. */
export function homeArrival(): HomeArrival | null {
  return pending;
}

/** Shown: the next Home that mounts isn't arriving from anything. */
export function clearHomeArrival(): void {
  pending = null;
}

/** The rail id of a session started elsewhere: a real chat's row is `chat:<id>`. */
export function railIdFor(sessionId: string, ids: readonly string[]): string | null {
  return ids.find((id) => id === sessionId || id === `chat:${sessionId}`) ?? null;
}
