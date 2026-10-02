import { defineEvent } from '../lib/ipc/events';

/**
 * Whether a rig or space is syncing on THIS computer — read by the main
 * process off the rig's own `.rig/` folder (`main/rig/sync-health.ts`) and
 * shown plainly wherever the space is: the Room, its Details panel, Home.
 *
 * The sync daemon (tapd) is a detached process per folder. Nothing brings
 * it back after a restart except the app (see `resumeSyncOnLaunch`), and a
 * space whose daemon isn't running quietly goes out of date — so every
 * state but `running` (and `notSynced`, a folder that was never set up to
 * sync) is said out loud, with the one action that fixes it.
 */
export type SyncHealth =
  | { state: 'running' }
  /** Not bound to the relay at all (a local-only rig): nothing to sync, nothing to say. */
  | { state: 'notSynced' }
  /** The app is starting it right now (launch, or a click on Resume). */
  | { state: 'starting' }
  /** `.rig/sync-paused.json` — someone chose to pause it (row menu, sign-out, delete/leave). */
  | { state: 'paused'; pausedAt: string | null; reason: string | null }
  /** Should be syncing, but no sync process is running for this folder. */
  | { state: 'stopped' }
  /** The app tried to start it and couldn't. */
  | { state: 'error'; message: string };

export type SyncNotice = {
  /** `warn` for "out of date until you act", `bad` for "we tried and it failed". */
  tone: 'warn' | 'bad';
  /** A few words for a chip. */
  short: string;
  /** A Home row's status line: what's wrong, said on its own. */
  line: string;
  /** The full sentence, for a banner or a tooltip. */
  text: string;
  /** Extra detail (an error's own message), when there is some. */
  detail?: string;
  /** The one button that fixes it, if there is one. Every action is "start the sync process". */
  action: string | null;
};

/** What to tell someone about `health` — null when there's nothing to say (syncing fine, or never synced). */
export function describeSyncHealth(health: SyncHealth | null | undefined): SyncNotice | null {
  if (!health) return null;
  switch (health.state) {
    case 'running':
    case 'notSynced':
      return null;
    case 'starting':
      return {
        tone: 'warn',
        short: 'Starting sync…',
        line: 'Starting sync…',
        text: 'Starting sync on this computer…',
        action: null,
      };
    case 'paused':
      if (health.reason === 'deleted') {
        return {
          tone: 'warn',
          short: 'Sync stopped',
          line: 'Sync stopped on this computer',
          text: 'Sync is stopped on this computer. This space was deleted or left.',
          action: null,
        };
      }
      return {
        tone: 'warn',
        short: 'Sync paused',
        line: 'Sync paused on this computer',
        text: 'Sync is paused on this computer. Your files may be out of date.',
        action: 'Resume',
      };
    case 'stopped':
      return {
        tone: 'warn',
        short: 'Not syncing',
        line: 'Not syncing on this computer',
        text: 'Sync isn’t running on this computer. Your files may be out of date.',
        action: 'Start syncing',
      };
    case 'error':
      return {
        tone: 'bad',
        short: 'Sync failed',
        line: 'Sync failed on this computer',
        text: 'Sync couldn’t start on this computer. Your files may be out of date.',
        detail: health.message,
        action: 'Try again',
      };
  }
}

/**
 * Main says a folder's sync state may have changed (the launch sweep
 * planned or finished a start, or someone pressed Start syncing): every
 * `useSyncHealth` showing `path` reads it again right away. A null `path`
 * means every folder.
 */
export const rigSyncHealthChangedChannel = defineEvent<{ path: string | null }>('rig:sync-health-changed');
