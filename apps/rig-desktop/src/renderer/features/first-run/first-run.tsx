import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { AgentField, type AgentFieldHandle } from '@renderer/lib/ui/agent-field';
import { cn } from '@renderer/lib/utils';
import {
  FIRST_RUN_STEP_IDS,
  type FirstRunProgress,
  type FirstRunStepId,
} from '@shared/rig/first-run';
import { ConnectStep } from './connect/connect-step';
import { FirstRunDebugPanel } from './debug/debug-panel';
import {
  clearFirstRunDebug,
  FIRST_RUN_CASES,
  useFirstRunDebug,
  type FirstRunSimulation,
} from './debug/first-run-debug';
import type { AgentState, FirstRunEnv, RigAccountState } from './env';
import {
  deriveFirstRun,
  nextStep,
  resumeStep,
  withSetup,
  type AgentReadiness,
  type FirstRunPlan,
  type RigAccountKind,
} from './first-run-state';
import { ReadStepView } from './read-step-view';
import { RealFirstRunEnv } from './real-env';
import { SetupStep } from './setup-step';
import { SimulatedFirstRunEnv } from './sim-env';
import { isBuiltStep } from './steps';
import { WelcomeStep } from './welcome-step';
import '@renderer/features/home-feed/home-feed.css';
import './first-run.css';

/** How long the stage takes to dissolve into Home. */
export const LEAVE_MS = 650;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** How the field behind the stage looks for a step. */
/**
 * `rest`: the field goes still and fades nearly out, for a moment of calm (All caught up).
 * `calm`: the read is done and a card is up; the grid breathes, slow and light.
 */
export type FieldLook = 'hero' | 'dim' | 'plain' | 'rest' | 'calm';

export type StepProps = {
  env: FirstRunEnv;
  plan: FirstRunPlan | null;
  /** "Step 2 of 7", counting Home; null on Welcome. */
  position: string | null;
  /** On to the next step, or Home. Waits for the plan when it isn't known yet. */
  onNext: () => void;
  /**
   * Not now: Home without the catch-up, for someone whose Claude can't do it yet (an API key,
   * another agent, no tools). The first run doesn't come back on its own.
   */
  onSkip: () => void;
  /** Waiting on the plan after `onNext`. */
  advancing: boolean;
  setFieldLook: (look: FieldLook) => void;
  field: RefObject<AgentFieldHandle | null>;
  /** Ends the first run and opens a session in its space (a started card's Open). Null in a simulation. */
  openSession: ((root: string, sessionId: string) => void) | null;
};

/**
 * The first run (rig/docs/onboarding-spec.md): one full window, a guide pane
 * on the left and a stage over the agent field on the right. App shows it
 * while `firstRunSeen` is behind `FIRST_RUN_VERSION`; it replaces the old
 * onboarding overlay, whose agent and sign-in steps are now Set up.
 *
 * With the debug harness on, a simulation (`debug/first-run-debug.ts`)
 * swaps the real environment for a made-up one; everything below the
 * environment is the same either way.
 */
export function FirstRun({
  firstRunSeen,
  hasSeenOnboarding,
  progress,
  alpha,
  debug,
  onDone,
  onOpenSession,
  onOpenSettings,
}: {
  firstRunSeen: number;
  hasSeenOnboarding: boolean;
  progress: FirstRunProgress | null;
  /**
   * Rig Alpha is on. Off, the first run shows only as a replay from the debug harness, and only
   * simulated: nothing real is read, made or written.
   */
  alpha: boolean;
  /** The debug harness is offered (dev builds, or Debug mode). */
  debug: boolean;
  onDone: () => void;
  /** After the first run ends: open this session in its space. */
  onOpenSession?: (root: string, sessionId: string) => void;
  /** Settings, over the first run: always reachable, so Rig Alpha can be turned off from it. */
  onOpenSettings?: () => void;
}) {
  const harness = useFirstRunDebug();
  const simulation = (debug ? harness.simulation : null) ?? (alpha ? null : FIRST_RUN_CASES[0]!.simulation);
  const startAt = debug ? harness.startAt : null;
  const render = (env: FirstRunEnv) => (
    <FirstRunShell
      env={env}
      startAt={startAt}
      debug={debug}
      simulation={simulation}
      real={alpha}
      onDone={onDone}
      onOpenSettings={onOpenSettings}
      // A simulation's sessions aren't real: nothing to open.
      onOpenSession={simulation ? null : (onOpenSession ?? null)}
    />
  );

  return simulation ? (
    <SimulatedFirstRunEnv key={harness.run} simulation={simulation}>
      {render}
    </SimulatedFirstRunEnv>
  ) : (
    <RealFirstRunEnv
      key={harness.run}
      firstRunSeen={firstRunSeen}
      hasSeenOnboarding={hasSeenOnboarding}
      progress={progress}
    >
      {render}
    </RealFirstRunEnv>
  );
}

function rigKind(rig: RigAccountState): RigAccountKind | null {
  return rig.kind === 'checking' ? null : rig.kind;
}

function agentKind(agent: AgentState): AgentReadiness | null {
  switch (agent.kind) {
    case 'checking':
      return null;
    case 'missing':
    case 'installing':
      return 'missing';
    case 'signedOut':
    case 'signingIn':
      return 'signedOut';
    case 'apiKey':
      return 'apiKey';
    case 'ready':
      return 'ready';
  }
}

function FirstRunShell({
  env,
  startAt,
  debug,
  simulation,
  real,
  onDone,
  onOpenSession,
  onOpenSettings,
}: {
  env: FirstRunEnv;
  /** A step the debug harness asked for: shown even when the plan would skip it. */
  startAt: FirstRunStepId | null;
  debug: boolean;
  /** What the environment simulates, if it does. */
  simulation: FirstRunSimulation | null;
  /** The debug harness may go back to this Mac as it is (Rig Alpha on). */
  real: boolean;
  onDone: () => void;
  onOpenSession: ((root: string, sessionId: string) => void) | null;
  onOpenSettings?: () => void;
}) {
  const field = useRef<AgentFieldHandle | null>(null);
  const [fieldLook, setFieldLook] = useState<FieldLook>('hero');
  const [step, setStep] = useState<FirstRunStepId>(
    () => startAt ?? env.user.progress?.step ?? 'welcome'
  );
  const [pendingNext, setPendingNext] = useState(false);

  // The plan is decided once, as soon as the account and the agent are both
  // known, so finishing Set up doesn't make Set up vanish from under it.
  const rig = rigKind(env.rig);
  const agent = agentKind(env.agent);
  const [plan, setPlan] = useState<FirstRunPlan | null>(null);
  useEffect(() => {
    if (plan || !rig || !agent) return;
    setPlan(
      deriveFirstRun({
        firstRunSeen: env.user.firstRunSeen,
        hasSeenOnboarding: env.user.hasSeenOnboarding,
        rig,
        agent,
      })
    );
  }, [plan, rig, agent, env.user.firstRunSeen, env.user.hasSeenOnboarding]);

  const steps = useMemo(() => {
    if (!plan) return null;
    return startAt && !plan.steps.includes(startAt)
      ? FIRST_RUN_STEP_IDS.filter((id) => id === startAt || plan.steps.includes(id))
      : plan.steps;
  }, [plan, startAt]);

  // Each step once as it shows, and Home at the end: where people stop.
  const tracked = useRef<string | null>(null);
  useEffect(() => {
    if (tracked.current === step) return;
    tracked.current = step;
    env.trackStep(step);
  }, [env, step]);

  // The end: the stage dissolves, the card going on toward Home's Feed, then Home fades in under it.
  const [leaving, setLeaving] = useState(false);
  const left = useRef(false);
  const done = useCallback(
    (how: 'finished' | 'skipped' = 'finished') => {
      if (left.current) return;
      left.current = true;
      // A skip isn't Home's count: drop-off shows where it was left.
      if (how === 'finished') env.trackStep('home');
      setLeaving(true);
      setFieldLook('rest');
      // Marked seen only once the stage has gone: App closes the first run as soon as it's seen,
      // and ending a simulation swaps the environment under the shell.
      setTimeout(
        () => {
          if (how === 'finished') env.finish();
          else env.skip();
          clearFirstRunDebug();
          onDone();
        },
        prefersReducedMotion() ? 0 : LEAVE_MS
      );
    },
    [env, onDone]
  );
  const skip = useCallback(() => done('skipped'), [done]);
  // Done, straight into the session a card just started, in its space.
  const openSession = useMemo(
    () =>
      onOpenSession
        ? (root: string, sessionId: string) => {
            done();
            onOpenSession(root, sessionId);
          }
        : null,
    [done, onOpenSession]
  );

  const go = useCallback(
    (target: FirstRunStepId, list: readonly FirstRunStepId[]) => {
      const landing = isBuiltStep(target) ? target : nextStep(list, target, isBuiltStep);
      if (!landing) {
        done();
        return;
      }
      setStep(landing);
      env.saveProgress({ step: landing, readStarted: env.user.progress?.readStarted ?? false });
    },
    [done, env]
  );

  // A resumed step the plan no longer has (Set up, finished elsewhere) moves on.
  const settled = useRef(false);
  useEffect(() => {
    if (!steps || settled.current) return;
    settled.current = true;
    if (steps.includes(step) && isBuiltStep(step)) return;
    const target = resumeStep(steps, env.user.progress ?? { step, readStarted: false }, rig === 'signedIn');
    if (target) go(target, steps);
    else done();
  }, [steps, step, rig, env.user.progress, go, done]);

  // Read needs a Rig sign-in the relay takes, asked again on the way in (a resume too): one that
  // lapsed goes to Set up's Sign in again, never to a read that can't start.
  const signInChecked = useRef<FirstRunStepId | null>(null);
  useEffect(() => {
    if (step !== 'read') {
      signInChecked.current = null;
      return;
    }
    if (!plan || !rig || signInChecked.current === step) return;
    signInChecked.current = step;
    if (rig === 'signedIn') return;
    const list = withSetup(plan.steps);
    setPlan({ ...plan, steps: list });
    go('setup', list);
  }, [step, rig, plan, go]);

  const advance = useCallback(() => {
    if (!steps) {
      setPendingNext(true);
      return;
    }
    const next = nextStep(steps, step, isBuiltStep);
    if (next) go(next, steps);
    else done();
  }, [steps, step, go, done]);

  useEffect(() => {
    if (pendingNext && steps) {
      setPendingNext(false);
      advance();
    }
  }, [pendingNext, steps, advance]);

  // Counted over the steps that show, and Home.
  const shown = steps?.filter(isBuiltStep) ?? null;
  const index = shown ? shown.indexOf(step) : -1;
  const props: StepProps = {
    env,
    plan,
    position:
      step === 'welcome' || !shown || index < 0 ? null : `Step ${index + 1} of ${shown.length + 1}`,
    onNext: advance,
    onSkip: skip,
    advancing: pendingNext,
    setFieldLook,
    field,
    openSession,
  };

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 grid grid-cols-[minmax(0,370px)_minmax(0,1fr)] bg-bg-0',
        leaving && 'fr-leaving'
      )}
    >
      {/* The window's own drag strip: the guide and stage stay clickable below it. */}
      <div className="absolute inset-x-0 top-0 z-20 h-10 [-webkit-app-region:drag]" />
      <div className="border-r border-border-hairline bg-bg-1" />
      <div className="fr-stage relative overflow-hidden">
        <div className="fr-field absolute inset-0" data-look={fieldLook}>
          <AgentField
            ref={field}
            mode={fieldLook === 'hero' || fieldLook === 'dim' ? 'ambient' : 'idle'}
          />
        </div>
      </div>
      <div className="absolute inset-0 z-10 grid grid-cols-[minmax(0,370px)_minmax(0,1fr)]">
        <StepView step={step} props={props} />
      </div>
      {onOpenSettings && (
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
          className="absolute top-2.5 right-3 z-30 grid size-7 place-items-center rounded-full text-text-muted transition-colors [-webkit-app-region:no-drag] hover:bg-bg-2 hover:text-text-primary"
          data-testid="first-run-settings"
        >
          <SettingsIcon className="size-4" strokeWidth={1.6} />
        </button>
      )}
      {debug && <FirstRunDebugPanel step={step} plan={plan} simulation={simulation} real={real} />}
      {env.overlay}
    </div>
  );
}

function StepView({ step, props }: { step: FirstRunStepId; props: StepProps }): ReactNode {
  switch (step) {
    case 'welcome':
      return <WelcomeStep {...props} />;
    case 'setup':
      return <SetupStep {...props} />;
    case 'connect':
      return <ConnectStep {...props} />;
    case 'read':
      return <ReadStepView {...props} />;
    // Not built (`steps.ts`): the shell moves past these, so they never show. First win's cards
    // are on the Read stage.
    case 'you':
    case 'firstWin':
      return null;
  }
}

/** A step's two halves: the guide pane, and what stands on the stage over the field. */
export function StepFrame({ guide, stage }: { guide: ReactNode; stage: ReactNode }) {
  return (
    <>
      <aside
        className="flex min-w-0 flex-col gap-3.5 overflow-y-auto px-[26px] pt-14 pb-[22px]"
      >
        {guide}
      </aside>
      <div className="grid min-w-0 place-items-center overflow-hidden p-6">{stage}</div>
    </>
  );
}

/**
 * The way out of Set up and Connect when they can't be finished here (Claude on an API key,
 * another agent, no tools): Home, without the catch-up. Settings › Advanced turns Rig Alpha off.
 */
export function NotNow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Go to your Home without catching up"
      className="ml-auto text-meta text-text-muted transition-colors hover:text-text-primary"
      data-testid="first-run-not-now"
    >
      Not now
    </button>
  );
}
