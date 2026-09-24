import { describe, expect, it, vi } from 'vitest';
import type { createSpacesDispatcher } from './dispatch';
import { SpacesDispatchController, type SpacesDispatchControllerDeps } from './dispatch-controller';
import type { RequestClaimPoller } from './request-claim';

function makeFakeDeps(overrides: Partial<SpacesDispatchControllerDeps> = {}) {
  let enabled = false;
  let signedIn = false;
  let settingsListener: (() => void) | null = null;
  let intervalCb: (() => void) | null = null;
  const startedPollers: number[] = [];
  const stoppedPollers: number[] = [];
  let nextId = 1;

  const deps: SpacesDispatchControllerDeps = {
    isEnabled: () => enabled,
    subscribeEnabled: (cb) => {
      settingsListener = cb;
      return () => {
        settingsListener = null;
      };
    },
    isSignedIn: async () => signedIn,
    startPoller: async () => {
      const id = nextId++;
      startedPollers.push(id);
      return {
        poller: {
          start: () => {},
          stop: () => stoppedPollers.push(id),
          checkNow: async () => {},
        } as unknown as RequestClaimPoller,
        dispatcher: {
          dispatch: vi.fn(),
          stopRun: vi.fn(async (runId: string) => runId === 'known-run'),
        } as unknown as ReturnType<typeof createSpacesDispatcher>,
      };
    },
    setInterval: (cb) => {
      intervalCb = cb;
      return 'interval-handle';
    },
    clearInterval: () => {
      intervalCb = null;
    },
    ...overrides,
  };

  return {
    deps,
    setEnabled: (v: boolean) => (enabled = v),
    setSignedIn: (v: boolean) => (signedIn = v),
    fireSettingsChange: () => settingsListener?.(),
    fireInterval: () => intervalCb?.(),
    startedPollers,
    stoppedPollers,
  };
}

describe('SpacesDispatchController', () => {
  it('does not start a poller when the flag is off, even if signed in', async () => {
    const fake = makeFakeDeps();
    fake.setEnabled(false);
    fake.setSignedIn(true);
    const controller = new SpacesDispatchController(fake.deps);

    controller.initialize();
    await controller.evaluate();

    expect(controller.isRunning()).toBe(false);
    expect(fake.startedPollers).toEqual([]);
  });

  it('does not start a poller when signed out, even if the flag is on', async () => {
    const fake = makeFakeDeps();
    fake.setEnabled(true);
    fake.setSignedIn(false);
    const controller = new SpacesDispatchController(fake.deps);

    controller.initialize();
    await controller.evaluate();

    expect(controller.isRunning()).toBe(false);
  });

  it('starts a poller once both the flag is on and the app is signed in', async () => {
    const fake = makeFakeDeps();
    fake.setEnabled(true);
    fake.setSignedIn(true);
    const controller = new SpacesDispatchController(fake.deps);

    // `evaluate()` directly — NOT `initialize()`, which would fire its own
    // concurrent `evaluate()` and race this one under the reentrancy guard.
    await controller.evaluate();

    expect(controller.isRunning()).toBe(true);
    expect(fake.startedPollers).toEqual([1]);
  });

  it('starts on a settings change that flips the flag on, and stops on one that flips it off', async () => {
    const fake = makeFakeDeps();
    fake.setSignedIn(true);
    const controller = new SpacesDispatchController(fake.deps);
    controller.initialize();
    expect(controller.isRunning()).toBe(false);

    fake.setEnabled(true);
    fake.fireSettingsChange();
    await vi.waitFor(() => expect(controller.isRunning()).toBe(true));

    fake.setEnabled(false);
    fake.fireSettingsChange();
    await vi.waitFor(() => expect(controller.isRunning()).toBe(false));
    expect(fake.stoppedPollers).toEqual([1]);
  });

  it('re-evaluates sign-in state on the periodic interval even without a settings change', async () => {
    const fake = makeFakeDeps();
    fake.setEnabled(true);
    fake.setSignedIn(false);
    const controller = new SpacesDispatchController(fake.deps);
    controller.initialize();
    await controller.evaluate();
    expect(controller.isRunning()).toBe(false);

    fake.setSignedIn(true);
    fake.fireInterval();
    await vi.waitFor(() => expect(controller.isRunning()).toBe(true));
  });

  it('never starts a second poller while one is already running', async () => {
    const fake = makeFakeDeps();
    fake.setEnabled(true);
    fake.setSignedIn(true);
    const controller = new SpacesDispatchController(fake.deps);
    await controller.evaluate();
    await controller.evaluate();
    await controller.evaluate();

    expect(fake.startedPollers).toEqual([1]);
  });

  it('dispose() stops a running poller and tears down subscriptions', async () => {
    const fake = makeFakeDeps();
    fake.setEnabled(true);
    fake.setSignedIn(true);
    const controller = new SpacesDispatchController(fake.deps);
    await controller.evaluate();
    expect(controller.isRunning()).toBe(true);

    controller.dispose();
    expect(controller.isRunning()).toBe(false);
    expect(fake.stoppedPollers).toEqual([1]);
  });

  it('stopRun delegates to the running dispatcher, and is false when nothing is running', async () => {
    const fake = makeFakeDeps();
    const controller = new SpacesDispatchController(fake.deps);
    expect(await controller.stopRun('known-run')).toBe(false); // nothing running yet

    fake.setEnabled(true);
    fake.setSignedIn(true);
    await controller.evaluate();

    expect(await controller.stopRun('known-run')).toBe(true);
    expect(await controller.stopRun('unknown-run')).toBe(false);
  });
});
