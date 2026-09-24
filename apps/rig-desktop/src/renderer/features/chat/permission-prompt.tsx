import { Check, ShieldAlert } from 'lucide-react';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';

/**
 * An agent's pending tool-permission ask: the command on one line, then one
 * button per ACP option. Shared by the chat composer and the Spaces session
 * card, so the two surfaces read as the same ask.
 *
 * Styling notes carried over from the chat composer (round E/F): mono
 * command text, `option.kind`-driven button variants, no extra card chrome —
 * Rule 9 reserves card chrome for file-edit summaries. The shield is the
 * same glyph the transcript's own tool line uses for its awaiting-permission
 * state (chat-ui's `IconShieldAlert`), neutral muted rather than chat-ui's
 * one-off amber: this app's tokens stay monochrome, teal is reserved for
 * "alive," not alerts.
 */
export function PermissionPrompt({
  title,
  options,
  resolvingOptionId,
  onResolve,
  className,
}: {
  title: string;
  options: { optionId: string; name: string; kind: string }[];
  resolvingOptionId: string | null;
  onResolve: (optionId: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <span className="flex items-center gap-1.5">
        <ShieldAlert className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
        <span className="font-mono text-xs break-all text-text-secondary">{title}</span>
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const isReject = option.kind.startsWith('reject');
          const isAlwaysAllow = option.kind === 'allow_always';
          const resolving = resolvingOptionId === option.optionId;
          return (
            <Button
              key={option.optionId}
              size="sm"
              // Allow = primary (filled); "Always Allow" = outlined
              // secondary, not filled — filled read as equal weight to
              // Allow (round F); Reject = ghost, quietest of the three.
              variant={isReject ? 'ghost' : isAlwaysAllow ? 'outline' : 'default'}
              // The whole row disables the moment ANY option is picked
              // (round E 5(b)) — the gap before the runtime actually
              // starts the tool reads as progress, not a dead click.
              disabled={resolvingOptionId !== null}
              onClick={() => onResolve(option.optionId)}
              // Round: permission option crop — `option.name` is the ACP
              // adapter's own raw string, sometimes with the whole shell
              // command restated inline ("Always Allow Bash(<command>)"),
              // which used to clip at the panel edge (`Button`'s base class
              // is `whitespace-nowrap shrink-0` on purpose everywhere else).
              // The command is already shown in full on the line above, so
              // truncating the label loses nothing; `title` keeps the
              // untruncated string one hover away.
              title={option.name}
            >
              {resolving ? (
                <>
                  <Check />
                  {isReject ? 'Rejected' : 'Allowed · running…'}
                </>
              ) : (
                <span className="max-w-56 truncate">{option.name}</span>
              )}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
