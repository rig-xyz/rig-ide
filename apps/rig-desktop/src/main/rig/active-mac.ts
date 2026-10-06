import type { Result } from '@emdash/shared';

/**
 * Which of your Macs you last used Rig on. Only Rig counts, not other apps.
 * When you bring a Rig window to the front, and every few minutes while it
 * stays there, this Mac tells the relay it's in use; otherwise it only asks
 * which Mac was used last. With Rig on one computer only, it never says
 * anything. The relay uses it to send a space's first agent request to the
 * Mac you're at; this app uses it to show banners only there.
 *
 * Pure apart from the injected deps, so it's unit-tested under `node`; the
 * real wiring is `wireActiveMac` in `active-mac-instance.ts`.
 */
export type ActiveMacDeps = {
  /** This Mac's id (`this-mac.ts`). */
  device: () => string;
  /** A Rig window is in front on this Mac. */
  rigInFront: () => boolean;
  /** Marks `markActive` in use, or only asks; answers with the Mac used last and how many you use Rig on. */
  activeComputer: (
    markActive?: string
  ) => Promise<Result<{ device: string | null; computers: number }, unknown>>;
};

/** How often to check in while nothing happens: ask, or say Rig is still in front. */
export const ACTIVE_MAC_INTERVAL_MS = 5 * 60_000;

export function createActiveMacTracker(deps: ActiveMacDeps) {
  let mostRecent: string | null = null;
  let computers = 0;

  return {
    /** Ask once, or, with Rig in front on one of several Macs, say this one is in use. */
    async tick(): Promise<void> {
      const device = deps.device();
      const mark = computers > 1 && deps.rigInFront() ? device : undefined;
      const result = await deps.activeComputer(mark);
      // A failure (signed out, offline) keeps what we knew.
      if (!result.success) return;
      mostRecent = result.data.device;
      computers = result.data.computers;
      // Just learned there's another Mac, with Rig in front here: say so now rather than in a few minutes.
      if (!mark && computers > 1 && deps.rigInFront()) {
        const marked = await deps.activeComputer(device);
        if (marked.success) mostRecent = marked.data.device;
      }
    },
    /**
     * You last used Rig on another Mac, and Rig isn't in front here. A relay
     * that doesn't know (none reported, or an older relay) never counts as
     * elsewhere.
     */
    usingAnotherMac(): boolean {
      return mostRecent !== null && mostRecent !== deps.device() && !deps.rigInFront();
    },
  };
}
