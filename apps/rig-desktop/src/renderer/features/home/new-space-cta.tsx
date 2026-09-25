import { Hash, Link as LinkIcon, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { normalizeJoinLink } from './join-link';
import { generateSpaceName } from './space-create';

/**
 * Polish round 2, lane F — Dylan's "Google-Meet style: boom, you're in"
 * primary action, placed right under the greeting/Ask (`home.tsx`, between
 * `BriefingSpine` and `NeedsYouSection`). One click: `generateSpaceName`
 * picks a friendly, unique-among-your-spaces name, and `onCreateSpace`
 * (`home.tsx`'s own `createSpace`, the SAME path the Spaces card's manual
 * "#name" field already drove) creates it and opens straight into its
 * Room — no naming dialog. `JoinWithLinkField` sits right beside it for the
 * other on-ramp: paste an invite link, it opens in the browser (the hub's
 * own `/join/<secret>` page owns accept-and-attach — see `join-link.ts`'s
 * header comment for why this doesn't re-implement that here).
 */
export function NewSpaceCta({
  existingNames,
  onCreateSpace,
}: {
  /** Every space name this account already has, for `generateSpaceName`'s collision check. */
  existingNames: ReadonlySet<string>;
  onCreateSpace: (name: string) => Promise<string | null>;
}) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const createOneClick = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    const name = generateSpaceName(existingNames);
    const failure = await onCreateSpace(name);
    setCreating(false);
    if (failure) setCreateError(failure);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => void createOneClick()}
          disabled={creating}
          className="welcome-cta bg-accent text-accent-ink focus-visible:outline-accent inline-flex shrink-0 items-center gap-2 rounded-chip px-5 py-2.5 text-sm font-medium outline-none transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60"
        >
          {creating ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
          ) : (
            <Hash className="size-4" strokeWidth={1.5} />
          )}
          {creating ? 'Starting…' : 'New space'}
        </button>
        <JoinWithLinkField />
      </div>
      {createError && <p className="text-danger text-xs">{createError}</p>}
    </div>
  );
}

/** The "paste an invite link" on-ramp — see this file's own header comment for what it does and doesn't do. */
function JoinWithLinkField() {
  const [value, setValue] = useState('');
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const url = normalizeJoinLink(value);
    if (!url) {
      setError("That doesn't look like a rig invite link.");
      return;
    }
    setOpening(true);
    setError(null);
    const result = await rpc.app.openExternal(url);
    setOpening(false);
    if (!result.success) {
      setError(result.error ?? "Couldn't open the browser.");
      return;
    }
    setValue('');
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="border-border-hairline focus-within:border-accent bg-bg-1 flex min-w-0 items-center gap-2 rounded-control border py-1.5 pr-1.5 pl-3 transition-colors"
      >
        <LinkIcon className="text-text-muted size-3.5 shrink-0" strokeWidth={1.5} />
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Join with a link…"
          disabled={opening}
          aria-label="Join with a link"
          className="text-text-primary placeholder:text-text-muted min-w-0 flex-1 bg-transparent text-sm outline-none disabled:cursor-not-allowed"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={opening || !value.trim()}>
          {opening ? 'Opening…' : 'Join'}
        </Button>
      </form>
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}
