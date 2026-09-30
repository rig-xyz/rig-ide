import { defineEvent } from '@shared/lib/ipc/events';

/**
 * Instant new space: Home's "New space" opens the Room at once, while main
 * sets the space up in the background (`main/rig/space-setup.ts`): the
 * folder first (synchronously, so the Room has a path and a name), then
 * one CLI call that writes rig.toml and creates the space on the relay
 * (`rig init --json --live --kind space --defer-upload`), then the Room is
 * live. The daemon uploads the first files right after.
 */

export type SpaceSetupStep =
  /** Writing rig.toml and creating the space on the relay (one `rig` process). */
  | 'goingLive'
  /** An older CLI or relay made a plain rig: marking it a space (`PATCH kind`). */
  | 'markingSpace'
  | 'live';

export type SpaceSetupError = { code: string; message: string };

export type SpaceSetup = {
  /** This setup's own id (the space has no binding id until it's live). */
  id: string;
  /** The space's name: its folder's basename, as rig.toml will say. */
  name: string;
  /** Its folder, created before `startSpace` returns. */
  path: string;
  status: 'working' | 'live' | 'failed';
  step: SpaceSetupStep;
  /** Set once live. */
  bindingId: string | null;
  homeUrl: string | null;
  error: SpaceSetupError | null;
  /**
   * Nothing usable exists yet (no binding on this computer): "Remove it"
   * deletes the folder too. Once bound it only forgets the setup.
   */
  removable: boolean;
};

/** Every change to a setup (a step, live, failed, removed). `removed: true` when it's gone. */
export type SpaceSetupEvent = SpaceSetup & { removed?: boolean };

export const rigSpaceSetupChannel = defineEvent<SpaceSetupEvent>('rig:space-setup');

/** Why Attach and Invite wait while a space is being set up. */
export const SPACE_SETUP_PENDING_REASON = 'Available in a moment…';
