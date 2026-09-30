import { DotMatrix } from '@renderer/lib/ui/dot-matrix';

/** A space still being set up, as the Room shows it (see `RoomView`'s `setup` prop). */
export type RoomSetup = {
  id: string;
  status: 'working' | 'live' | 'failed';
  error: string | null;
  /** Nothing usable was made yet: "Remove it" also deletes the folder. */
  removable: boolean;
  onRetry: () => void;
  onRemove: () => void;
};

/**
 * The Room's body while a new space is set up in the background: its name,
 * and the dot matrix's "starting" ripple (one shared, reduced-motion-aware
 * clock — `lib/ui/dot-matrix.tsx`). The composer below stays usable. A
 * failure says why, inline, with Retry and "Remove it" — never a dead end.
 */
export function SpaceSetupState({
  spaceName,
  failed,
  error,
  removable,
  onRetry,
  onRemove,
}: {
  spaceName: string;
  failed: boolean;
  error: string | null;
  removable: boolean;
  onRetry: () => void;
  onRemove: () => void;
}) {
  if (failed) {
    const action =
      'border-border-hairline bg-bg-1 hover:bg-bg-2 flex h-8 items-center rounded-chip border px-3 text-sm text-text-primary transition-colors';
    return (
      <div
        className="card-pop-in flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 text-center"
        role="alert"
        data-testid="space-setup-failed"
      >
        <DotMatrix state="failed" size="lg" />
        <div className="flex max-w-md flex-col gap-1">
          <h2 className="font-display text-xl text-text-primary">{spaceName} couldn’t be set up</h2>
          <p className="text-sm text-text-secondary">{error ?? 'Something went wrong while setting it up.'}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className={action} onClick={onRetry}>
            Retry
          </button>
          <button
            type="button"
            className={action}
            onClick={onRemove}
            title={removable ? 'Deletes its empty folder on this computer' : 'Its folder stays on this computer'}
          >
            Remove it
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 text-center"
      role="status"
      aria-live="polite"
      data-testid="space-setup"
    >
      <DotMatrix state="starting" size="lg" />
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl text-text-primary">{spaceName}</h2>
        <p className="text-sm text-text-secondary">Setting up your space…</p>
      </div>
      <p className="text-xs text-text-muted">You can start typing. Your message goes as soon as it’s ready.</p>
    </div>
  );
}
