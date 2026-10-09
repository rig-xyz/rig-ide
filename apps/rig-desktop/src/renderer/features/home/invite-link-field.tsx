import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { joinWithInviteLink } from './join-with-link';

/**
 * "Have an invite link?" on the first-run screen: always showing, so
 * someone sent a link can paste it before they have any space.
 */
export function InviteLinkField({
  onOpenPath,
  needsConnection,
}: {
  onOpenPath: (path: string, opts?: { kind?: 'space' }) => void;
  needsConnection: boolean;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const [value, setValue] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const submit = async () => {
    setJoining(true);
    setError(null);
    setNote(null);
    const outcome = await joinWithInviteLink(value, queryClient).catch(() => ({
      kind: 'error' as const,
      message: "Rig couldn't join with that link. Try again.",
    }));
    setJoining(false);
    if (outcome.kind === 'error') return setError(outcome.message);
    setValue('');
    if (outcome.kind === 'browser') return setNote('The invite opened in your browser. Sign in there to join.');
    onOpenPath(outcome.path, outcome.space ? { kind: 'space' } : undefined);
  };

  return (
    <form
      className="flex w-full flex-col gap-1.5 text-left"
      data-testid="invite-link-field"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="text-text-muted text-xs">
        Have an invite link?
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Paste it here"
          disabled={joining || needsConnection}
          className="border-border-hairline bg-bg-1 text-text-primary placeholder:text-text-muted focus-visible:border-accent min-w-0 flex-1 rounded-control border px-3 py-1.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button type="submit" size="sm" variant="outline" disabled={joining || needsConnection || !value.trim()}>
          {joining && <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />}
          {joining ? 'Joining…' : 'Join'}
        </Button>
      </div>
      {error && (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      )}
      {note && <p className="text-text-muted text-xs">{note}</p>}
    </form>
  );
}
