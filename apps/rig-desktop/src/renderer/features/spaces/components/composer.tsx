import { AtSign, CornerDownLeft, CornerUpLeft, Paperclip, Sparkles, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import type { RoomAgent, RoomMember, RoomReplyRef, RoomSkill } from '../types';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';

const TYPING_IDLE_MS = 4000;
const DRAFT_PREFIX = 'rig-room-draft:';

/**
 * Spaces: the Room's composer. `/` at the start opens the space's skills,
 * `@` opens people and agents (agents first, each labelled); both menus
 * filter as you type, move with ↑/↓, pick with ↵ or Tab and close with Esc.
 * A quote-reply shows as a banner above the input (Esc or × drops it). An
 * unsent draft is kept per space on this computer, so switching away never
 * costs the sentence. When your agent is mid-turn, mentioning it says the
 * request will wait its turn.
 */

type MenuItem = {
  key: string;
  section?: string;
  icon: ReactNode;
  label: string;
  detail: string;
  apply: () => void;
};

function readDraft(key: string | undefined): string {
  if (!key) return '';
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string | undefined, value: string): void {
  if (!key) return;
  try {
    if (value.trim()) localStorage.setItem(DRAFT_PREFIX + key, value);
    else localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // Storage unavailable: the draft just isn't kept.
  }
}

export function Composer({
  spaceName,
  draftKey,
  members,
  agents,
  skills,
  onSend,
  onTypingChange,
  replyTo,
  onCancelReply,
  busyAgents = [],
  prefill,
}: {
  spaceName: string;
  /** Where this composer keeps its unsent draft (the space's id); no draft kept without one. */
  draftKey?: string;
  members: RoomMember[];
  agents: RoomAgent[];
  skills: RoomSkill[];
  onSend: (text: string, replyTo?: RoomReplyRef) => void;
  /** Called with true while the user is typing, false after a few idle seconds or on send. */
  onTypingChange?: (typing: boolean) => void;
  replyTo?: RoomReplyRef | null;
  onCancelReply?: () => void;
  /** Your agents that are mid-turn right now. */
  busyAgents?: RoomAgent['agent'][];
  /** Puts this text in the input and focuses it (a new `nonce` each time). */
  prefill?: { text: string; nonce: number } | null;
}) {
  const [value, setValue] = useState(() => readDraft(draftKey));
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setValue(readDraft(draftKey)), [draftKey]);
  useEffect(() => writeDraft(draftKey, value), [draftKey, value]);
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);
  useEffect(() => {
    if (!prefill) return;
    setValue(prefill.text);
    textareaRef.current?.focus();
  }, [prefill]);

  const skillQuery = /^\/(\S*)$/.exec(value)?.[1] ?? null;
  const mentionQuery = useMemo(() => /(?:^|\s)@([a-z]*)$/i.exec(value)?.[1] ?? null, [value]);

  const applyMention = (label: string) => {
    setValue((current) => current.replace(/(?:^|\s)@([a-z]*)$/i, (m) => `${m[0] === ' ' ? ' ' : ''}@${label} `));
    textareaRef.current?.focus();
  };
  const applySkill = (skill: RoomSkill) => {
    setValue(`${skill.cmd} `);
    textareaRef.current?.focus();
  };

  const items: MenuItem[] = useMemo(() => {
    if (skillQuery !== null) {
      const q = skillQuery.toLowerCase();
      return skills
        .filter((skill) => skill.cmd.slice(1).toLowerCase().startsWith(q) || skill.name.toLowerCase().includes(q))
        .map((skill) => {
          const addedBy = members.find((m) => m.id === skill.addedBy);
          return {
            key: skill.cmd,
            icon: <Sparkles className="size-3.5 text-text-muted" strokeWidth={1.5} />,
            label: skill.cmd,
            detail: [skill.desc, addedBy ? `added by ${addedBy.name}` : ''].filter(Boolean).join(' · '),
            apply: () => applySkill(skill),
          };
        });
    }
    if (mentionQuery !== null) {
      const q = mentionQuery.toLowerCase();
      const agentItems: MenuItem[] = agents
        .filter((a) => a.agent.startsWith(q))
        .map((a) => ({
          key: `agent-${a.agent}`,
          section: 'Agents',
          icon: <AgentAvatar agent={a.agent} owner={members.find((m) => m.id === a.owner)} size="sm" />,
          label: a.agent,
          detail: busyAgents.includes(a.agent) ? `your ${AGENT_NAME[a.agent]} · working` : `your ${AGENT_NAME[a.agent]}`,
          apply: () => applyMention(a.agent),
        }));
      const peopleItems: MenuItem[] = members
        .filter((m) => m.status === 'here' && m.name.toLowerCase().startsWith(q))
        .map((m) => ({
          key: `person-${m.id}`,
          section: 'People',
          icon: <PersonAvatar member={m} size="sm" />,
          label: m.name,
          detail: m.online === false ? 'away' : m.online ? 'here now' : '',
          apply: () => applyMention(m.name),
        }));
      return [...agentItems, ...peopleItems];
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillQuery, mentionQuery, skills, members, agents, busyAgents]);

  const menuOpen = items.length > 0 && dismissedFor !== value;
  useEffect(() => setActive(0), [skillQuery, mentionQuery]);

  // Typing presence: on while there's input and recent keystrokes, off
  // after a short idle or on send.
  const typingRef = useRef(false);
  const typingIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setTyping = (typing: boolean) => {
    if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
    typingIdleRef.current = typing ? setTimeout(() => setTyping(false), TYPING_IDLE_MS) : null;
    if (typingRef.current === typing) return;
    typingRef.current = typing;
    onTypingChange?.(typing);
  };
  useEffect(
    () => () => {
      if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
    },
    []
  );

  const send = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed, replyTo ?? undefined);
    setValue('');
    setTyping(false);
  };

  const mentionedBusy = busyAgents.find((agent) => new RegExp(`@${agent}\\b`, 'i').test(value));

  return (
    <div className="relative">
      {menuOpen && (
        <div
          className="popover-in border-border-hairline bg-bg-1 shadow-float absolute right-0 bottom-full left-0 z-10 mb-2 flex max-h-72 flex-col overflow-y-auto rounded-card border p-1.5"
          data-testid={skillQuery !== null ? 'skills-palette' : 'mention-palette'}
          role="listbox"
        >
          {skillQuery !== null && <p className="px-2 pt-1 pb-1 text-2xs text-text-muted">Skills in this space</p>}
          {items.map((item, i) => (
            <div key={item.key}>
              {item.section && item.section !== items[i - 1]?.section && (
                <p className="px-2 pt-1.5 pb-1 text-2xs text-text-muted">{item.section}</p>
              )}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={item.apply}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors',
                  i === active && 'bg-bg-2'
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">{item.icon}</span>
                <span className={cn('text-sm text-text-primary', skillQuery !== null && 'font-mono')}>
                  {skillQuery !== null ? item.label : `@${item.label}`}
                </span>
                <span className="min-w-0 truncate text-xs text-text-muted">{item.detail}</span>
                {i === active && (
                  <CornerDownLeft className="ml-auto size-3 shrink-0 text-text-muted" strokeWidth={1.5} />
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className={cn(
          'border-border-hairline bg-bg-1 rounded-card border transition-colors',
          focused && 'border-accent shadow-[0_0_0_3px_var(--accent-subtle)]'
        )}
      >
        {replyTo && (
          <div
            className="border-border-hairline flex items-center gap-2 border-b px-3.5 py-2 text-xs text-text-muted"
            data-testid="composer-reply"
          >
            <CornerUpLeft className="size-3.5 shrink-0" strokeWidth={1.5} />
            <span className="shrink-0">Replying to</span>
            <b className="shrink-0 font-medium text-text-secondary">{replyTo.label}</b>
            <span className="min-w-0 truncate">{replyTo.excerpt}</span>
            <button
              type="button"
              onClick={onCancelReply}
              aria-label="Cancel reply"
              className="hover:bg-bg-2 ml-auto flex size-5 shrink-0 items-center justify-center rounded-control transition-colors hover:text-text-primary"
            >
              <X className="size-3" strokeWidth={1.5} />
            </button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setTyping(e.target.value.trim().length > 0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setActive((i) => (i + step + items.length) % items.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                items[active]?.apply();
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissedFor(value);
                return;
              }
            }
            if (e.key === 'Escape' && replyTo) {
              e.preventDefault();
              onCancelReply?.();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={replyTo ? `Reply to ${replyTo.label}` : `Message ${spaceName}`}
          rows={1}
          className="placeholder:text-text-muted min-h-[40px] w-full resize-none bg-transparent px-3.5 py-2.5 text-sm text-text-primary outline-none"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <button
            type="button"
            aria-label="Attach a file"
            title="Attach a file"
            className="hover:bg-bg-2 flex size-7 items-center justify-center rounded-control text-text-muted transition-colors"
          >
            <Paperclip className="size-3.5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            aria-label="Mention someone"
            title="Mention someone"
            onClick={() => {
              setValue((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@`);
              textareaRef.current?.focus();
            }}
            className="hover:bg-bg-2 flex size-7 items-center justify-center rounded-control text-text-muted transition-colors"
          >
            <AtSign className="size-3.5" strokeWidth={1.5} />
          </button>
          {mentionedBusy && (
            <span className="ml-1 text-xs text-text-muted" data-testid="composer-queue-note">
              Your {AGENT_NAME[mentionedBusy]} is working; this goes after its current turn.
            </span>
          )}
          <button
            type="button"
            onClick={send}
            disabled={!value.trim()}
            className={cn(
              'ml-auto flex h-6.5 items-center gap-1.5 rounded-control px-2.5 text-xs transition-colors disabled:opacity-60',
              value.trim() ? 'bg-accent text-accent-ink' : 'bg-bg-2 text-text-secondary'
            )}
          >
            {replyTo ? 'Reply' : 'Send'}
            <CornerDownLeft className="size-3" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
