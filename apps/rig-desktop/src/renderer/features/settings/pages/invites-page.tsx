import { relativeTime } from '@renderer/features/chat/session-history';
import { useInviteActions } from '@renderer/features/shell/invites-bell';
import { emptyInvitesMessage, type MyInviteRow } from '@renderer/features/shell/invites-inbox';
import { useMyInvites } from '@renderer/features/shell/use-my-invites';
import { Button } from '@renderer/lib/ui/button';
import { settingsRow } from '../settings-pages';
import { SettingsRow, SettingsRows } from '../settings-row';

/**
 * Settings › Invites: the invites addressed to you, one row each, with Accept and Decline. With
 * Rig Alpha on this is where invites live (the Activity bell is put away): the page's entry in
 * Settings' list and your row at the foot of the sidebar both carry their count. With none, one
 * row says so and names the address they were looked up for.
 */
export function InvitesPage({
  onOpenPath,
  onClose,
}: {
  /** Opens the space an accepted invite was to, once it is set up on this computer. */
  onOpenPath: (path: string) => void;
  /** Closes Settings, so the space that opens is seen. */
  onClose: () => void;
}) {
  const { signedIn, email, rows, failed } = useMyInvites();
  const entry = settingsRow('invites')!;
  if (!rows || rows.length === 0) {
    const [label, description] = !signedIn
      ? ['Not signed in', 'Sign in on the Account page to see invites sent to you.']
      : rows
        ? [emptyInvitesMessage(email), 'An invite to a space shows here, with who sent it.']
        : failed
          ? ["Rig couldn't check for invites", 'They show here once it can reach your account.']
          : ['Checking for invites…', undefined];
    return (
      <SettingsRows>
        <SettingsRow id={entry.id} label={label} description={description} />
      </SettingsRows>
    );
  }
  return (
    <SettingsRows>
      {rows.map((row, index) => (
        <InviteSettingsRow
          key={row.id}
          // The first carries the page's search id, so "Invites" in Settings' search lands here.
          id={index === 0 ? entry.id : undefined}
          row={row}
          onOpenPath={onOpenPath}
          onClose={onClose}
        />
      ))}
    </SettingsRows>
  );
}

function InviteSettingsRow({
  id,
  row,
  onOpenPath,
  onClose,
}: {
  id?: string;
  row: MyInviteRow;
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const { phase, error, settingUp, setupError, accept, decline, setUpLocally } = useInviteActions(
    row,
    onOpenPath,
    onClose
  );
  const when = relativeTime(Date.parse(row.createdAt), Date.now());
  const problem = error ?? setupError;
  return (
    <SettingsRow
      id={id}
      label={`Invite to ${row.label}`}
      description={`${row.inviterLabel} invited you${when === 'now' ? ' just now' : ` ${when}`}. You ${row.roleLabel}.`}
      detail={problem ? <p className="text-danger text-[12.5px] leading-normal">{problem}</p> : undefined}
      control={
        phase === 'joined' ? (
          <Button variant="outline" size="xs" onClick={() => void setUpLocally()} disabled={settingUp}>
            {settingUp ? 'Setting up…' : 'Set up on this computer'}
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={() => void decline()} disabled={phase !== 'idle'}>
              {phase === 'declining' ? 'Declining…' : 'Decline'}
            </Button>
            <Button size="xs" onClick={() => void accept()} disabled={phase !== 'idle'}>
              {phase === 'joining' ? 'Joining…' : 'Accept'}
            </Button>
          </>
        )
      }
    />
  );
}
