import type { Result } from '@emdash/shared';

/**
 * Which of your Macs you're at. Every `intervalMs` this Mac tells the relay
 * it's in use when someone touched it since the last tick (any app, not just
 * Rig), and otherwise asks which Mac was used last. The relay uses it to
 * give the Mac you're at the first go at your agent requests; this app uses
 * it to show banners only there.
 *
 * Pure apart from the injected deps, so it's unit-tested under `node`; the
 * real wiring is `wireActiveMac` in `active-mac-instance.ts`.
 */
export type ActiveMacDeps = {
  /** This Mac's id (`this-mac.ts`). */
  device: () => string;
  /** Seconds since the last keyboard or mouse input on this Mac. */
  idleSeconds: () => number;
  /** Marks `markActive` in use, or only asks; answers with the Mac used most recently. */
  activeComputer: (markActive?: string) => Promise<Result<{ device: string | null }, unknown>>;
};

export const ACTIVE_MAC_INTERVAL_MS = 30_000;

export function createActiveMacTracker(deps: ActiveMacDeps, intervalMs = ACTIVE_MAC_INTERVAL_MS) {
  let mostRecent: string | null = null;
  const inUse = () => deps.idleSeconds() * 1000 < intervalMs;

  return {
    /** Report or ask once. `force`: this Mac was just woken or unlocked, so it's in use. */
    async tick(force = false): Promise<void> {
      const device = deps.device();
      const result = await deps.activeComputer(force || inUse() ? device : undefined);
      // A failure (signed out, offline) keeps what we knew.
      if (result.success) mostRecent = result.data.device;
    },
    /**
     * You were last at another Mac, and haven't touched this one since. A
     * relay that doesn't know (none reported, or an older relay) never
     * counts as elsewhere.
     */
    usingAnotherMac(): boolean {
      return mostRecent !== null && mostRecent !== deps.device() && !inUse();
    },
  };
}
