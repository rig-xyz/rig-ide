import { Check } from 'lucide-react';

/** The small "Done" under an ask of you in the For you focus: it hides the ask, for good on this computer. */
export function AskDone({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex pt-1 pl-10">
      <button
        type="button"
        onClick={onDone}
        data-testid="ask-done"
        className="flex h-6 items-center gap-1 rounded-full px-2 text-xs text-text-muted transition-colors hover:bg-bg-2 hover:text-text-primary"
      >
        <Check className="size-3" strokeWidth={1.75} />
        Done
      </button>
    </div>
  );
}
