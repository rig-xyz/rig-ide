export type TurnOutcome = 'completed' | 'error' | 'timeout';

export function createTurnDeadline(options: {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  onAbsoluteTimeout?: (awaitingPermission: boolean) => void;
  onFinish?: () => void;
}): {
  outcome: Promise<TurnOutcome>;
  finish: (outcome: TurnOutcome) => void;
  noteActivity: () => void;
  setAwaitingPermission: (waiting: boolean) => void;
  dispose: () => void;
} {
  let settle: (outcome: TurnOutcome) => void = () => {};
  const outcome = new Promise<TurnOutcome>((resolve) => {
    settle = resolve;
  });
  let live = true;
  let waiting = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let absoluteTimer: ReturnType<typeof setTimeout> | null = null;

  const stopIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const finish = (value: TurnOutcome): void => {
    if (!live) return;
    live = false;
    stopIdle();
    if (absoluteTimer) clearTimeout(absoluteTimer);
    absoluteTimer = null;
    options.onFinish?.();
    settle(value);
  };
  const armIdle = (): void => {
    stopIdle();
    if (waiting) return;
    idleTimer = setTimeout(() => finish('timeout'), options.idleTimeoutMs);
  };

  absoluteTimer = setTimeout(() => {
    options.onAbsoluteTimeout?.(waiting);
    finish('timeout');
  }, options.absoluteTimeoutMs);
  armIdle();

  return {
    outcome,
    finish,
    noteActivity: (): void => {
      if (live) armIdle();
    },
    setAwaitingPermission: (next: boolean): void => {
      if (!live || next === waiting) return;
      waiting = next;
      if (next) stopIdle();
      else armIdle();
    },
    dispose: () => finish('timeout'),
  };
}
