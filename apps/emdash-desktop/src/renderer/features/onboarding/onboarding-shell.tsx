import { Check } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@renderer/utils/utils';
import { AgentStep } from './agent-step';
import { ImportStep } from './import-step';
import { RigSignInStep } from './rig-sign-in-step';

type OnboardingStep = 'agent' | 'rigSignIn' | 'import';

const stepConfig: Record<
  OnboardingStep,
  { label: string; component: React.ComponentType<{ onComplete: () => void }> }
> = {
  agent: {
    label: 'Agent',
    component: AgentStep,
  },
  rigSignIn: {
    label: 'Sign in',
    component: RigSignInStep,
  },
  import: {
    label: 'Import',
    component: ImportStep,
  },
};

/**
 * Small centered progress indicator: numbered dots joined by hairlines, ticks
 * for completed steps. Replaces the old browser-style tab strip that sat on the
 * corner of a giant bordered panel.
 */
function StepIndicator({ steps, activeIndex }: { steps: OnboardingStep[]; activeIndex: number }) {
  if (steps.length < 2) return null;
  return (
    <div className="flex items-center gap-2.5">
      {steps.map((step, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div key={step} className="flex items-center gap-2.5">
            {index > 0 && <div className="h-px w-8 bg-border" />}
            <div
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 text-xs',
                active ? 'text-foreground' : 'text-foreground-muted'
              )}
            >
              <span
                className={cn(
                  'flex h-4.5 w-4.5 items-center justify-center rounded-full border text-[10px] tabular-nums',
                  done && 'border-transparent bg-background-2 text-foreground-muted',
                  active && 'border-foreground/40',
                  !done && !active && 'border-border'
                )}
              >
                {done ? <Check className="h-2.5 w-2.5" /> : index + 1}
              </span>
              {stepConfig[step].label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OnboardingShell({
  steps,
  onComplete,
}: {
  steps: OnboardingStep[];
  onComplete: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeStep = steps[activeIndex];
  const StepComponent = stepConfig[activeStep]?.component;

  const handleStepComplete = () => {
    const nextIndex = activeIndex + 1;
    if (nextIndex >= steps.length) {
      onComplete();
    } else {
      setActiveIndex(nextIndex);
    }
  };

  return (
    // A plain centered column on the plain background, like the welcome
    // screen — no panel. `my-auto` on the inner column centers it when it
    // fits and degrades to normal top-anchored scrolling (scrollbar at the
    // window edge, nothing clipped) when the window is short.
    <div className="flex h-full w-full flex-col items-center overflow-y-auto [-webkit-app-region:no-drag]">
      <div className="my-auto flex w-full max-w-md flex-col items-center gap-10 px-6 py-12">
        <StepIndicator steps={steps} activeIndex={activeIndex} />
        <StepComponent onComplete={handleStepComplete} />
      </div>
    </div>
  );
}
