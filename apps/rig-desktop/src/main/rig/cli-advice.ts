import { app } from 'electron';

/**
 * What a failed `rig` CLI step tells people. A packaged app runs its own
 * bundled CLI, so "run this in a terminal" or "npm i -g" can't help anyone
 * there: they get a plain sentence and a next step inside the app. A dev
 * build keeps the terminal hints, which are real advice for a developer
 * running their own CLI (see `join.ts`'s `outdatedCliMessage`).
 */

function packaged(): boolean {
  return app?.isPackaged ?? false;
}

/** The `rig` CLI couldn't be started at all. */
export function cliMissingMessage(bin: string, isPackaged = packaged()): string {
  return isPackaged
    ? 'Rig couldn’t start one of its parts. Reinstall Rig from userig.xyz.'
    : `Could not run \`${bin}\`. Install the rig CLI (npm i -g @rigxyz/cli) and try again.`;
}

/** `rig login` gave up waiting for the browser. */
export function signInTimedOutMessage(isPackaged = packaged()): string {
  return isPackaged ? 'Sign-in timed out. Try again.' : 'Sign-in timed out. Try again, or run `rig login` in a terminal.';
}

/** `rig login` never printed the sign-in page's address. */
export function noSignInLinkMessage(isPackaged = packaged()): string {
  return isPackaged
    ? 'Rig couldn’t open the sign-in page. Try again.'
    : 'rig login did not print a sign-in link. Try running `rig login` in a terminal.';
}
