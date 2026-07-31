import { useState } from 'react';
import { OnboardingShell } from './onboarding-shell';

type OnboardingStep = 'agent' | 'rigSignIn' | 'import';

export function Onboarding({
  steps: initialSteps,
  onComplete,
}: {
  steps: OnboardingStep[];
  onComplete: () => void;
}) {
  const [steps] = useState(initialSteps);

  return (
    // fixed inset-0 z-50 + opaque bg, matching WelcomeScreen: first-run owns
    // the whole window. The root was transparent and parent-sized before, so
    // anything else painting (kept-alive panes, stale layers) showed through
    // around and beneath the centered shell.
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background [-webkit-app-region:drag]">
      <OnboardingShell steps={steps} onComplete={onComplete} />
    </div>
  );
}
