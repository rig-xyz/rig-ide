import { log } from '@main/lib/logger';
import type { createSpacesDispatcher } from './dispatch';
import type { RequestClaimPoller } from './request-claim';

/**
 * Spaces (lane 4): owns the ONE `RequestClaimPoller` this device runs,
 * starting it exactly when the goal's own gate is satisfied — the
 * `spacesEnabled` experimental setting is on AND the app is signed in to
 * Rig — and stopping it the moment either stops being true, rather than
 * leaving it polling (and failing) in the background.
 *
 * There is no existing "signed in/out" event in this codebase to react to
 * directly (`account.ts`'s `resolveContext()` is a point-in-time read, same
 * as every other relay caller's own trust-gated resolution), so sign-in is
 * re-checked on a plain interval in addition to every `spacesEnabled`
 * settings change — up to `REEVALUATE_INTERVAL_MS` of latency noticing a
 * sign-in/out that happened with the flag already on, which is an
 * acceptable trade for not inventing a new cross-cutting account-changed
 * event for this one lane. `evaluate()` is reentrancy-guarded so an
 * overlapping settings-change + interval tick can't double-start a poller.
 *
 * This file itself imports nothing Electron- or database-touching (only
 * types) so it can be unit-tested under the plain `node` Vitest project —
 * see `dispatch-controller.test.ts`. The real wiring (settings store, ACP
 * runtime client, relay API) lives in `dispatch-controller-instance.ts`,
 * which every value this class needs comes from as injected `deps` — that
 * file is boot-only, never imported by a test.
 */

const REEVALUATE_INTERVAL_MS = 15_000;

/** Everything real-world/impure this controller needs — injected so `evaluate()`'s gating logic is unit-testable against fakes, with no real relay, ACP runtime, or settings file. */
export type SpacesDispatchControllerDeps = {
  isEnabled: () => boolean;
  subscribeEnabled: (cb: () => void) => () => void;
  isSignedIn: () => Promise<boolean>;
  startPoller: () => Promise<{
    poller: RequestClaimPoller;
    dispatcher: ReturnType<typeof createSpacesDispatcher>;
  }>;
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export class SpacesDispatchController {
  private poller: RequestClaimPoller | null = null;
  private dispatcher: ReturnType<typeof createSpacesDispatcher> | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private reevaluateTimer: unknown = null;
  private evaluating = false;

  constructor(private readonly deps: SpacesDispatchControllerDeps) {}

  initialize(): void {
    this.unsubscribeSettings = this.deps.subscribeEnabled(() => void this.evaluate());
    this.reevaluateTimer = this.deps.setInterval(() => void this.evaluate(), REEVALUATE_INTERVAL_MS);
    void this.evaluate();
  }

  dispose(): void {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    if (this.reevaluateTimer !== null) this.deps.clearInterval(this.reevaluateTimer);
    this.reevaluateTimer = null;
    this.poller?.stop();
    this.poller = null;
    this.dispatcher = null;
  }

  /** True while a poller is running — for tests; not otherwise consumed. */
  isRunning(): boolean {
    return this.poller !== null;
  }

  /** Used by the `spacesDispatch.stopRun` RPC route. `false` when nothing is running, or this device has no such run. */
  async stopRun(runId: string, bindingId?: string): Promise<boolean> {
    if (!this.dispatcher) return false;
    return this.dispatcher.stopRun(runId, bindingId);
  }

  /** Runs a turn in the owner's room agent with no relay request behind it (doc comments in a space). Null when the dispatcher isn't running (Spaces off, or signed out). */
  runLocal(
    spec: Parameters<ReturnType<typeof createSpacesDispatcher>['runLocal']>[0]
  ): ReturnType<ReturnType<typeof createSpacesDispatcher>['runLocal']> | null {
    return this.dispatcher ? this.dispatcher.runLocal(spec) : null;
  }

  /** Used by the `spacesDispatch.checkNow` RPC route: the Room just filed a request, so claim it now instead of on the next tick. */
  async checkNow(): Promise<void> {
    await this.poller?.checkNow();
  }

  /** Used by the `spacesDispatch.resolvePermission` RPC route: the owner answering an approval from their own session card. */
  async resolvePermission(runId: string, requestId: string, optionId: string): Promise<boolean> {
    if (!this.dispatcher) return false;
    return this.dispatcher.resolvePermission(runId, requestId, optionId);
  }

  async evaluate(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const enabled = this.deps.isEnabled();
      // Skip the relay round trip entirely when the flag is off — the whole
      // point of gating on it.
      const signedIn = enabled ? await this.deps.isSignedIn() : false;
      const shouldRun = enabled && signedIn;

      if (shouldRun && !this.poller) {
        const { poller, dispatcher } = await this.deps.startPoller();
        this.poller = poller;
        this.dispatcher = dispatcher;
        log.info('Rig spaces: request-claim poller started');
      } else if (!shouldRun && this.poller) {
        this.poller.stop();
        this.poller = null;
        this.dispatcher = null;
        log.info('Rig spaces: request-claim poller stopped');
      }
    } catch (error) {
      log.warn('Rig spaces: failed to evaluate whether the request-claim poller should run', {
        error: String(error),
      });
    } finally {
      this.evaluating = false;
    }
  }
}
