import { AtSign, CornerDownLeft, Paperclip, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { cn } from '@renderer/lib/utils';
import { agentLogoId, BrandLogo } from '../logos';
import type { RoomAgent, RoomMember, RoomSkill } from '../types';

const TYPING_IDLE_MS = 4000;

/**
 * Spaces (lane 2): the composer. A `/` as the first character opens the
 * skills palette ("Skills in this space", who added each); `@` anywhere
 * opens people+agents completion; `+` is the files affordance (presentation
 * only against the fixture — there's no real attach target yet). Enter
 * sends; the button doubles as a mnemonic (↵) rather than hiding the key.
 */

export function Composer({
  spaceName,
  members,
  agents,
  skills,
  onSend,
  onTypingChange,
}: {
  spaceName: string;
  members: RoomMember[];
  agents: RoomAgent[];
  skills: RoomSkill[];
  onSend: (text: string) => void;
  /** Called with true while the user is typing, false after a few idle seconds or on send. */
  onTypingChange?: (typing: boolean) => void;
}) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const showSkillsPalette = value.startsWith('/');
  const mentionQuery = useMemo(() => {
    const match = /(?:^|\s)@([a-z]*)$/i.exec(value);
    return match ? match[1] : null;
  }, [value]);

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const people = members
      .filter((m) => m.status === 'here')
      .map((m) => ({ id: m.id, label: m.name, kind: 'person' as const }));
    const agentOptions = agents.map((a) => ({
      id: a.agent,
      label: a.agent === 'claude' ? 'claude' : 'codex',
      kind: 'agent' as const,
    }));
    return [...people, ...agentOptions].filter((o) => o.label.toLowerCase().startsWith(q));
  }, [mentionQuery, members, agents]);

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
    onSend(trimmed);
    setValue('');
    setTyping(false);
  };

  const applyMention = (label: string) => {
    setValue((current) => current.replace(/(?:^|\s)@([a-z]*)$/i, (m) => `${m[0] === ' ' ? ' ' : ''}@${label} `));
    textareaRef.current?.focus();
  };

  const applySkill = (skill: RoomSkill) => {
    setValue(skill.cmd);
    textareaRef.current?.focus();
  };

  return (
    <div className="relative">
      {showSkillsPalette && skills.length > 0 && (
        <div
          className="border-border-hairline bg-bg-1 shadow-float absolute right-0 bottom-full left-0 z-10 mb-2 flex flex-col gap-0.5 rounded-card border p-1.5"
          data-testid="skills-palette"
        >
          <p className="px-2 pt-1 pb-1 font-mono text-2xs tracking-wide text-text-muted uppercase">
            Skills in this space
          </p>
          {skills.map((skill) => {
            const addedBy = members.find((m) => m.id === skill.addedBy);
            return (
              <button
                key={skill.cmd}
                type="button"
                onClick={() => applySkill(skill)}
                className="hover:bg-bg-2 flex items-center gap-2.5 rounded-control p-2 text-left transition-colors"
              >
                <Sparkles className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />
                <span className="font-mono text-sm text-text-primary">{skill.cmd}</span>
                <span className="min-w-0 truncate text-xs text-text-secondary">{skill.desc}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs whitespace-nowrap text-text-muted">
                  <IdentityAvatar name={addedBy?.name ?? skill.addedBy} avatarUrl={null} sizeClassName="size-4" textClassName="text-2xs" />
                  added by {addedBy?.name ?? skill.addedBy}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!showSkillsPalette && mentionOptions.length > 0 && (
        <div
          className="border-border-hairline bg-bg-1 shadow-float absolute right-0 bottom-full left-0 z-10 mb-2 flex flex-col gap-0.5 rounded-card border p-1.5"
          data-testid="mention-palette"
        >
          {mentionOptions.map((option) => (
            <button
              key={`${option.kind}-${option.id}`}
              type="button"
              onClick={() => applyMention(option.label)}
              className="hover:bg-bg-2 flex items-center gap-2.5 rounded-control p-2 text-left text-sm text-text-primary transition-colors"
            >
              {option.kind === 'agent' ? (
                <BrandLogo id={agentLogoId(option.id as 'claude' | 'codex')} size={14} />
              ) : (
                <IdentityAvatar name={option.label} avatarUrl={null} sizeClassName="size-4" textClassName="text-2xs" />
              )}
              @{option.label}
            </button>
          ))}
        </div>
      )}

      <div
        className={cn(
          'border-border-hairline bg-bg-1 rounded-card border transition-colors',
          focused && 'border-accent shadow-[0_0_0_3px_var(--accent-subtle)]'
        )}
      >
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
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Message ${spaceName}`}
          rows={1}
          className="placeholder:text-text-muted min-h-[40px] w-full resize-none bg-transparent px-3.5 py-2.5 text-sm text-text-primary outline-none"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <button
            type="button"
            aria-label="Attach a file"
            className="hover:bg-bg-2 flex size-7 items-center justify-center rounded-control text-text-muted transition-colors"
          >
            <Paperclip className="size-3.5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            aria-label="Mention someone"
            onClick={() => setValue((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@`)}
            className="hover:bg-bg-2 flex size-7 items-center justify-center rounded-control text-text-muted transition-colors"
          >
            <AtSign className="size-3.5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={send}
            disabled={!value.trim()}
            className={cn(
              'ml-auto flex h-6.5 items-center gap-1.5 rounded-control px-2.5 text-xs transition-colors disabled:opacity-60',
              value.trim() ? 'bg-accent text-accent-ink' : 'bg-bg-2 text-text-secondary'
            )}
          >
            Enter
            <CornerDownLeft className="size-3" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
