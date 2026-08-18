import { Check } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@renderer/lib/utils';
import { AgentsStep } from './agents-step';
import { SignInStep } from './sign-in-step';
import type { OnboardingStep } from './onboarding-state';

/**
 * First-run onboarding (round H2) — fullscreen, first-run only (gated by
 * `App.tsx` on `RigSettings.hasSeenOnboarding` via `deriveOnboardingSteps`).
 * No separate welcome splash: the brand moment folds into `AgentsStep`'s
 * own header (it's always index 0 — `deriveOnboardingSteps` never omits
 * `'agents'`) rather than a standalone screen first. `steps` is the frozen
 * array `App.tsx` already computed once via `deriveOnboardingSteps` — this
 * component doesn't re-derive it, so a mid-flow sign-in (finishing step 2
 * after already having decided steps once) can't retroactively change the
 * step count out from under `activeIndex`.
 */
export function Onboarding({ steps, onComplete }: { steps: OnboardingStep[]; onComplete: () => void }) {
  const [activeIndex, setActiveIndex] = useState(0);

  const handleStepComplete = () => {
    const next = activeIndex + 1;
    if (next >= steps.length) onComplete();
    else setActiveIndex(next);
  };

  const step = steps[activeIndex];
  if (!step) return null;

  return (
    // fixed inset-0 + opaque bg: first-run owns the whole window, same
    // reasoning as everywhere else in this app that does this (the replay
    // bar, the artifact view) — nothing behind it should show through.
    <div className="bg-bg-1 fixed inset-0 z-50 flex flex-col items-center justify-center [-webkit-app-region:drag]">
      <div className="flex w-full max-w-md flex-col items-center gap-8 overflow-y-auto px-6 py-12 [-webkit-app-region:no-drag]">
        <StepDots steps={steps} activeIndex={activeIndex} />
        {step === 'agents' && <AgentsStep onComplete={handleStepComplete} />}
        {step === 'signIn' && <SignInStep onComplete={handleStepComplete} />}
      </div>
    </div>
  );
}

/** Numbered dots joined by hairlines, ticks for completed steps — absent entirely for a one-step wizard (round H2: sign-in can drop out when already signed in). */
function StepDots({ steps, activeIndex }: { steps: OnboardingStep[]; activeIndex: number }) {
  if (steps.length < 2) return null;
  return (
    <div className="flex items-center gap-2.5">
      {steps.map((step, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div key={step} className="flex items-center gap-2.5">
            {index > 0 && <div className="bg-border-hairline h-px w-8" />}
            <div
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 text-xs',
                active ? 'text-text-primary' : 'text-text-muted'
              )}
            >
              <span
                className={cn(
                  'flex size-[18px] items-center justify-center rounded-full border text-xs tabular-nums',
                  done && 'border-transparent bg-bg-2 text-text-muted',
                  active && 'border-text-primary/40',
                  !done && !active && 'border-border-hairline'
                )}
              >
                {done ? <Check className="size-2.5" /> : index + 1}
              </span>
              {step === 'agents' ? 'Agent' : 'Sign in'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
