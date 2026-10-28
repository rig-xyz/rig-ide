import { err, type Result } from '@emdash/shared';
import { FIRST_RUN_VERSION } from '@shared/rig/first-run';

/**
 * Rig Alpha (Settings › Advanced) gates everything new: the first run, the
 * Feed, the Home space and the background reads. With it off the app is the
 * current release, and none of these run.
 */

export const ALPHA_OFF = 'Rig Alpha is off (Settings › Advanced).';

/** A click on something of Rig Alpha's: refused while it's off. */
export function alphaOnly<A extends unknown[], T>(
  alphaOn: () => boolean,
  fn: (...args: A) => Promise<Result<T, { message: string }>>
): (...args: A) => Promise<Result<T, { message: string }>> {
  return (...args) => (alphaOn() ? fn(...args) : Promise.resolve(err({ message: ALPHA_OFF })));
}

/**
 * Rig reads on its own (app start, every hour, after sleep) only with Alpha
 * on, the first run behind them, and a read they've had at least once: the
 * first run's, or Catch me up on Home. Not now leaves the first run without
 * one, and then Rig waits to be asked.
 */
export function readsOnItsOwn(settings: { alphaEnabled: boolean; firstRunSeen: number }, readBefore: boolean): boolean {
  return mayAskRelay(settings) && readBefore;
}

/** Whether to ask the relay if Rig has read for them before (only when that could let a read start). */
export function mayAskRelay(settings: { alphaEnabled: boolean; firstRunSeen: number }): boolean {
  return settings.alphaEnabled && settings.firstRunSeen >= FIRST_RUN_VERSION;
}
