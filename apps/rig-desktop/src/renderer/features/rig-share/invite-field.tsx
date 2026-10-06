import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Check, Copy, X } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  addChip,
  chipKey,
  chipLabel,
  commitQuery,
  type InviteChip,
  inviteRequests,
  isValidEmail,
  NOT_AN_EMAIL,
  rankCollaborators,
  rankPeople,
  sendLabel,
  splitTyped,
} from '@renderer/features/people/people-state';
import { PEOPLE_QUERY_KEY, usePeople } from '@renderer/features/people/use-people';
import { useClipboard } from '@renderer/lib/hooks/use-clipboard';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import type { RigInviteMinted, RigInviteRole, RigMember } from '@shared/rig/rig-share';
import { mintedInviteMatchesRole } from './invite-state';
import { invitesKey, usePendingInvites } from './people-section';

/**
 * Invite by name (board 26, panel 1). The field takes names or emails: as
 * you type it suggests Your people (`rig.share.people`), people you know
 * through your organization after them, and leaves out whoever is already
 * in the space or invited. A pick becomes a chip; a full email becomes an
 * email chip. One Send mints one invite per chip, a person by id and an
 * email by address. "Copy link" is the explicit open link anyone can use.
 *
 * An older relay without `/v1/me/people` gets today's suggestions instead
 * (members of your other spaces, `rig.share.collaborators`), and a pick
 * there becomes an email chip, since that relay can only invite an address.
 */

type Suggestion = {
  key: string;
  name: string;
  avatarUrl: string | null;
  why: string;
  group: string;
  chip: InviteChip;
};

type Sent = { chip: InviteChip; minted: RigInviteMinted };

export function InviteByName({
  root,
  spaceName,
  currentMembers,
}: {
  root: string;
  spaceName: string | null;
  currentMembers: RigMember[];
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [chips, setChips] = useState<InviteChip[]>([]);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [role, setRole] = useState<RigInviteRole>('editor');
  const [sending, setSending] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const [link, setLink] = useState<RigInviteMinted | null>(null);
  const clipboard = useClipboard();

  const { supported, people } = usePeople();
  const { pending } = usePendingInvites(root, currentMembers, true);

  // The older relay's fan-out, only asked for once `/v1/me/people` said no.
  const fallback = supported === false;
  const workspacesQuery = useQuery({
    queryKey: ['rig', 'account', 'workspaces'],
    queryFn: () => rpc.rig.account.workspaces(),
    enabled: fallback,
  });
  const bindingIds = workspacesQuery.data?.success
    ? workspacesQuery.data.data.map((b) => b.id)
    : [];
  const collaboratorsQuery = useQuery({
    queryKey: ['rig', 'share', 'collaborators', ...bindingIds],
    queryFn: () => rpc.rig.share.collaborators({ bindingIds }),
    enabled: fallback && bindingIds.length > 0,
    staleTime: 60_000,
  });

  const exclude = new Set<string>([
    ...currentMembers.map((m) => m.userId),
    ...pending.flatMap((invite) => (invite.targetUserId ? [invite.targetUserId] : [])),
    ...chips.flatMap((chip) => (chip.kind === 'person' ? [chip.userId] : [])),
  ]);
  const excludeEmails = new Set<string>([
    ...pending.flatMap((invite) => (invite.email ? [invite.email.toLowerCase()] : [])),
    ...chips.flatMap((chip) => (chip.kind === 'email' ? [chip.email.toLowerCase()] : [])),
  ]);

  const suggestions: Suggestion[] = fallback
    ? rankCollaborators(collaboratorsQuery.data?.success ? collaboratorsQuery.data.data : [], {
        query,
        exclude,
        excludeEmails,
      }).map((member) => ({
        key: member.userId,
        name: member.name ?? member.email ?? '',
        avatarUrl: member.avatarUrl,
        why: member.name ? (member.email ?? '') : '',
        group: 'People from your spaces',
        chip: { kind: 'email', email: member.email ?? '' },
      }))
    : rankPeople(people, { query, exclude, nowMs: Date.now() }).map((person) => ({
        key: person.userId,
        name: person.name,
        avatarUrl: person.avatarUrl,
        why: person.why,
        group: person.group === 'org' ? 'Your organization' : 'Your people',
        chip: {
          kind: 'person',
          userId: person.userId,
          name: person.name,
          avatarUrl: person.avatarUrl,
        },
      }));

  const typedEmail = isValidEmail(query) ? query.trim() : null;
  const active = Math.min(highlight, Math.max(0, suggestions.length - 1));
  // With chips picked and nothing typed, the list stays closed so it doesn't sit over Send.
  const showList =
    focused && (query.trim().length > 0 || (chips.length === 0 && suggestions.length > 0));
  // Chips to send: the picked ones, plus a full email still sitting in the field.
  const toSend = typedEmail ? addChip(chips, { kind: 'email', email: typedEmail }) : chips;

  const pick = (chip: InviteChip) => {
    setChips((current) => addChip(current, chip));
    setQuery('');
    setHighlight(0);
    setError(null);
  };

  const send = async () => {
    if (query.trim() && !typedEmail) {
      setError(NOT_AN_EMAIL);
      return;
    }
    if (toSend.length === 0) {
      inputRef.current?.focus();
      return;
    }
    setSending(true);
    setError(null);
    setSent([]);
    const done: Sent[] = [];
    const failed: InviteChip[] = [];
    const messages: string[] = [];
    for (const request of inviteRequests(toSend, role)) {
      const result = await rpc.rig.share.createInvite({
        root,
        email: request.email,
        targetUserId: request.targetUserId,
        role: request.role,
      });
      if (result.success) done.push({ chip: request.chip, minted: result.data });
      else {
        failed.push(request.chip);
        messages.push(
          toSend.length > 1
            ? `${chipLabel(request.chip)}: ${result.error.message}`
            : result.error.message
        );
      }
    }
    setSending(false);
    setChips(failed);
    setQuery('');
    setSent(done);
    setError(messages.length > 0 ? messages.join(' ') : null);
    if (done.length > 0) {
      void queryClient.invalidateQueries({ queryKey: invitesKey(root) });
      void queryClient.invalidateQueries({ queryKey: PEOPLE_QUERY_KEY });
    }
  };

  const copyLink = async () => {
    setLinking(true);
    setError(null);
    const result = await rpc.rig.share.createInvite({
      root,
      email: null,
      targetUserId: null,
      role,
    });
    setLinking(false);
    if (!result.success) {
      setError(result.error.message);
      return;
    }
    setLink(result.data);
    clipboard.copy(result.data.url);
    void queryClient.invalidateQueries({ queryKey: invitesKey(root) });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((active + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((active - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (sending) return;
      if (query.trim() && suggestions[active] && !typedEmail) {
        pick(suggestions[active].chip);
      } else if (query.trim()) {
        const next = commitQuery(query, chips);
        setChips(next.chips);
        setQuery(next.query);
        setError(next.error);
      } else if (chips.length > 0) {
        void send();
      } else if (suggestions[active] && focused) {
        pick(suggestions[active].chip);
      }
    } else if (event.key === 'Backspace' && query === '' && chips.length > 0) {
      setChips(chips.slice(0, -1));
    }
  };

  const displayedLink = link && mintedInviteMatchesRole(link.invite.role, role) ? link : null;
  let lastGroup: string | null = null;

  return (
    <div
      className="flex flex-col gap-2.5 border-t border-border-hairline pt-3"
      data-testid="invite-by-name"
    >
      <p className="px-1 text-xs text-text-muted">
        {spaceName ? `Invite to ${spaceName}` : 'Invite people'}
      </p>

      <div className="relative">
        <div
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault();
              inputRef.current?.focus();
            }
          }}
          className="flex min-h-8 flex-wrap items-center gap-1 rounded-control border border-border-hairline bg-bg-1 px-1.5 py-1"
        >
          {chips.map((chip) => (
            <span
              key={chipKey(chip)}
              data-testid="invite-chip"
              className="flex max-w-full items-center gap-1 rounded-chip bg-bg-2 py-0.5 pr-0.5 pl-1 text-xs text-text-primary"
            >
              {chip.kind === 'person' ? (
                <IdentityAvatar
                  name={chip.name}
                  avatarUrl={chip.avatarUrl}
                  sizeClassName="size-4"
                  textClassName="text-2xs"
                />
              ) : (
                <AtSign className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
              )}
              <span className="truncate">{chipLabel(chip)}</span>
              <button
                type="button"
                onClick={() =>
                  setChips((current) => current.filter((c) => chipKey(c) !== chipKey(chip)))
                }
                aria-label={`Remove ${chipLabel(chip)}`}
                className="rounded-full p-0.5 text-text-muted hover:text-text-primary"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            type="text"
            data-testid="invite-field"
            value={query}
            onChange={(event) => {
              const next = splitTyped(event.target.value, chips);
              setChips(next.chips);
              setQuery(next.query);
              setError(next.error);
              setHighlight(0);
              setFocused(true);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              // Leaving the field with a full email in it keeps it as a chip.
              if (typedEmail) {
                setChips((current) => addChip(current, { kind: 'email', email: typedEmail }));
                setQuery('');
              }
            }}
            onKeyDown={onKeyDown}
            placeholder={chips.length === 0 ? 'Name or email' : 'Add someone else'}
            aria-label="Name or email"
            className="min-w-24 flex-1 bg-transparent px-1 py-0.5 text-xs text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        {/* An overlay, not in-flow content: blurring the field (e.g. by
            pressing Send) hides the list, and an in-flow list would shift
            the button out from under that very click. */}
        {showList && (
          <div
            data-testid="invite-suggestions"
            role="listbox"
            className={cn(
              'border-border-hairline bg-bg-1 rounded-control shadow-soft absolute inset-x-0 top-full z-10 mt-1 flex max-h-64 flex-col gap-0.5 overflow-y-auto border p-1',
              // Only a hint inside: a click goes through to the Send button under it.
              suggestions.length === 0 && !typedEmail && 'pointer-events-none'
            )}
          >
            {suggestions.map((s, index) => {
              const header = s.group !== lastGroup ? s.group : null;
              lastGroup = s.group;
              return (
                <div key={s.key} className="flex flex-col">
                  {header && (
                    <p className="px-1.5 pt-1 pb-0.5 text-2xs text-text-muted">{header}</p>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    onMouseDown={(event) => {
                      // Keeps the field focused, so this click isn't a blur that hides the list first.
                      event.preventDefault();
                      pick(s.chip);
                    }}
                    onMouseEnter={() => setHighlight(index)}
                    className={cn(
                      'rounded-control flex items-center gap-2 px-1.5 py-1 text-left transition-colors',
                      index === active ? 'bg-bg-2' : 'hover:bg-bg-2'
                    )}
                  >
                    <IdentityAvatar
                      name={s.name}
                      avatarUrl={s.avatarUrl}
                      sizeClassName="size-5"
                      textClassName="text-2xs"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-text-primary">{s.name}</span>
                      {s.why && (
                        <span className="block truncate text-2xs text-text-muted">{s.why}</span>
                      )}
                    </span>
                  </button>
                </div>
              );
            })}
            {query.trim() &&
              suggestions.length === 0 &&
              (typedEmail ? (
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick({ kind: 'email', email: typedEmail });
                  }}
                  className="flex items-center gap-2 rounded-control px-1.5 py-1 text-left hover:bg-bg-2"
                >
                  <AtSign className="size-4 shrink-0 text-text-muted" strokeWidth={1.5} />
                  <span className="truncate text-xs text-text-primary">Invite {typedEmail}</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 px-1.5 py-1">
                  <AtSign className="size-4 shrink-0 text-text-muted" strokeWidth={1.5} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-text-primary">Invite by email</span>
                    <span className="block text-2xs text-text-muted">
                      Type a full address. Rig never looks strangers up by name.
                    </span>
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-control border border-border-hairline p-1">
        {(
          [
            ['editor', 'Can edit'],
            ['viewer', 'Can view'],
          ] as const
        ).map(([option, label]) => (
          <button
            key={option}
            type="button"
            onClick={() => setRole(option)}
            aria-pressed={role === option}
            className={cn(
              'rounded-control px-2.5 py-1.5 text-xs transition-colors',
              role === option
                ? 'bg-bg-2 text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" onClick={() => void copyLink()} disabled={linking}>
          {linking ? 'Creating…' : displayedLink && clipboard.copied ? 'Copied' : 'Copy link'}
        </Button>
        <Button size="sm" className="flex-1" onClick={() => void send()} disabled={sending}>
          {sendLabel(Math.max(1, toSend.length), sending)}
        </Button>
      </div>

      {sent.length > 0 && <SentInvites sent={sent} />}
      {displayedLink && (
        <LinkBox
          url={displayedLink.url}
          note="Anyone with this link can join, so send it to whoever you’re inviting."
        />
      )}
    </div>
  );
}

/** What each sent invite did: a person sees it in Rig, an email went out, or here's the link to send yourself. */
function SentInvites({ sent }: { sent: Sent[] }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="sent-invites">
      {sent.map(({ chip, minted }) =>
        chip.kind === 'person' ? (
          <p key={chipKey(chip)} className="text-xs text-text-secondary">
            Invited {chip.name}. They’ll see it in Rig.
          </p>
        ) : minted.email.sent ? (
          <p key={chipKey(chip)} className="text-xs text-text-secondary">
            Invite emailed to {minted.email.to ?? chip.email}.
          </p>
        ) : (
          <LinkBox
            key={chipKey(chip)}
            url={minted.url}
            note={`Email couldn’t be sent. Copy the link and send it to ${chip.email} yourself; only they can use it.`}
          />
        )
      )}
    </div>
  );
}

/** The one moment a secret-bearing link exists client-side; the invites list never carries it again. */
function LinkBox({ url, note }: { url: string; note: string }) {
  const clipboard = useClipboard();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 rounded-control border border-border-hairline bg-bg-2 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">{url}</span>
        <button
          type="button"
          onClick={() => clipboard.copy(url)}
          aria-label={clipboard.copied ? 'Copied' : 'Copy link'}
          className="flex shrink-0 items-center gap-1 text-xs text-text-muted transition-colors hover:text-text-primary"
        >
          {clipboard.copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {clipboard.copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-xs text-text-muted">{note}</p>
    </div>
  );
}
