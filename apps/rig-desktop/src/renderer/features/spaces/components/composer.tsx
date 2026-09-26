import { AtSign, CornerDownLeft, CornerUpLeft, FileText, Paperclip, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import { agentLogoId, BrandLogo } from '../logos';
import type { AgentKind, RoomAgent, RoomMember, RoomReplyRef, RoomSkill } from '../types';
import { AgentSettings } from './agent-settings';
import { ContextPill } from './context-pill';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';

const TYPING_IDLE_MS = 4000;
const DRAFT_PREFIX = 'rig-room-draft:';
/** A typing pause this long asks whether the draft answers your agent. */
const SUGGEST_DEBOUNCE_MS = 500;
/** How sure the relay must be before the draft goes to your agent by default. */
export const SUGGEST_MIN_CONFIDENCE = 0.5;

/**
 * Spaces: the Room's composer. `/` at the start opens the space's skills,
 * `@` opens people and agents (agents first, each labelled); both menus
 * filter as you type, move with ↑/↓, pick with ↵ or Tab and close with Esc.
 * A quote-reply shows as a banner above the input (Esc or × drops it). An
 * unsent draft is kept per space on this computer, so switching away never
 * costs the sentence. When your agent is mid-turn, mentioning it says the
 * request will wait its turn.
 *
 * A plain reply to your own agent (no @) reaches it too: on a typing pause
 * the composer asks `suggestReply` whether the draft answers one of your
 * agent's recent turns, and when it's sure enough shows one pill: your
 * agent and the turn it answers ("?" says why). A draft that starts by
 * calling one of your agents by name ("hey claude, …") gets the same pill
 * without a turn. No settings on it: the turn continues with whatever your
 * agent last ran with. × (or Esc) drops it for the rest of the draft and
 * the message goes to the room as plain chat.
 */

/** What the composer understood about a message, sent along with its text. */
/** The composer's guess that a plain draft answers your own agent's turn. */
export type ComposerSuggestion = { agent: AgentKind; replyTo: RoomReplyRef; confidence: number };

/** Any @mention, of an agent or a person (an email's `x@y.com` isn't one). */
function hasMention(text: string): boolean {
  return /(^|\s)@[a-z0-9_-]+/i.test(text);
}

/**
 * Which of your agents a plain draft starts by calling by name, maybe after
 * a greeting: "hey claude what's up?", "Claude, can you…", "codex: …". A
 * name later in the sentence ("I asked claude yesterday"), inside a word
 * ("claudette") or as a possessive ("claude's answer") doesn't count.
 */
export function addressedAgent(
  draft: string,
  agents: readonly RoomAgent[]
): { agent: AgentKind; word: string } | null {
  const word = /^(?:(?:hey|hi|hello|ok|okay|so|yo)[\s,!.]+)?([a-z]+)(?=$|[\s,:;!?.])/i.exec(draft.trim())?.[1];
  const agent = agents.find((a) => a.agent === word?.toLowerCase())?.agent;
  return agent && word ? { agent, word } : null;
}

/** Still the draft a guess was made for: typed on, or trimmed back, not rewritten. */
function sameDraft(guessedFor: string, now: string): boolean {
  return !!now && (now.startsWith(guessedFor) || guessedFor.startsWith(now));
}

export type ComposerSendContext = {
  replyTo?: RoomReplyRef;
  /** Your agent this message asks (its @tag, unless you dropped the pill); null for plain chat. */
  agent: AgentKind | null;
  /** A doc to give the agent as context. */
  attach: string | null;
};

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
  openDoc = null,
  agentModels,
  suggestReply,
}: {
  spaceName: string;
  /** Where this composer keeps its unsent draft (the space's id); no draft kept without one. */
  draftKey?: string;
  members: RoomMember[];
  agents: RoomAgent[];
  skills: RoomSkill[];
  onSend: (text: string, context: ComposerSendContext) => void;
  /** Called with true while the user is typing, false after a few idle seconds or on send. */
  onTypingChange?: (typing: boolean) => void;
  replyTo?: RoomReplyRef | null;
  onCancelReply?: () => void;
  /** Your agents that are mid-turn right now. */
  busyAgents?: RoomAgent['agent'][];
  /** Puts this text in the input and focuses it (a new `nonce` each time). */
  prefill?: { text: string; nonce: number } | null;
  /** The doc open beside the Room (its path in the space), offered as context when you ask your agent. */
  openDoc?: string | null;
  /** The model each of your agents last ran here, shown in its pill until its own list loads. */
  agentModels?: Partial<Record<AgentKind, string | null>>;
  /** Whether a plain draft answers one of your own agent's turns; null when not (or unsure). */
  suggestReply?: (draft: string) => Promise<ComposerSuggestion | null>;
}) {
  const [value, setValue] = useState(() => readDraft(draftKey));
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // Pills you dropped for this message; a fresh message starts clean.
  const [droppedAgent, setDroppedAgent] = useState(false);
  const [droppedDoc, setDroppedDoc] = useState(false);
  // The guess that this draft answers your agent, and whether you dropped it
  // (which also drops a name-address: one × for "not to my agent").
  const [suggestion, setSuggestion] = useState<{ draft: string; value: ComposerSuggestion } | null>(null);
  const [droppedSuggestion, setDroppedSuggestion] = useState(false);
  useEffect(() => {
    if (value.trim()) return;
    setDroppedAgent(false);
    setDroppedDoc(false);
    setDroppedSuggestion(false);
  }, [value]);
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

  // Ask on a typing pause; a newer keystroke drops the answer to an older one.
  useEffect(() => {
    const draft = value.trim();
    if (!suggestReply || replyTo || droppedSuggestion || !draft || draft.startsWith('/') || hasMention(draft)) {
      setSuggestion(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void suggestReply(draft)
        .catch(() => null)
        .then((guess) => {
          if (stale) return;
          setSuggestion(guess && guess.confidence >= SUGGEST_MIN_CONFIDENCE ? { draft, value: guess } : null);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [value, suggestReply, replyTo, droppedSuggestion]);

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
  const mentioning = menuOpen && skillQuery === null;
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

  // Your agent is tagged once its @name is written out; dropping the pill
  // sends the message as plain chat instead.
  const tagged = agents.find((a) => new RegExp(`(^|\\s)@${a.agent}(\\s|$)`, 'i').test(value));
  // Only a guess about your own agent, and only while it's still this draft.
  const suggested =
    suggestion &&
    !droppedSuggestion &&
    !replyTo &&
    !hasMention(value) &&
    agents.some((a) => a.agent === suggestion.value.agent) &&
    sameDraft(suggestion.draft, value.trim())
      ? suggestion.value
      : null;
  // Called by name at the start, no @ and no Reply chosen.
  const addressed =
    !replyTo && !droppedSuggestion && !hasMention(value) ? addressedAgent(value, agents) : null;
  // Your agent without an @, as one pill: a guessed reply wins (it carries the
  // turn). Never beside the other pills: they need an @ or a Reply you chose.
  const ownPill: { agent: AgentKind; replyTo: RoomReplyRef | null; reason: string } | null = suggested
    ? {
        agent: suggested.agent,
        replyTo: suggested.replyTo,
        reason: `Looks like your answer to ${AGENT_NAME[suggested.agent]}'s question, so it goes to ${AGENT_NAME[suggested.agent]}.`,
      }
    : addressed
      ? {
          agent: addressed.agent,
          replyTo: null,
          reason: `You started with "${addressed.word}", so it goes to ${AGENT_NAME[addressed.agent]}.`,
        }
      : null;
  const agentPill = tagged && !droppedAgent ? tagged.agent : null;
  const replyPill = replyTo ?? null;
  const docPill = agentPill && openDoc && !droppedDoc ? openDoc : null;
  const sendsTo = agentPill ?? ownPill?.agent ?? null;
  const dropSuggestion = () => {
    setDroppedSuggestion(true);
    textareaRef.current?.focus();
  };

  const send = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed, { replyTo: replyPill ?? ownPill?.replyTo ?? undefined, agent: sendsTo, attach: docPill });
    setValue('');
    setSuggestion(null);
    setTyping(false);
  };

  const mentionedBusy = busyAgents.find((agent) => new RegExp(`@${agent}\\b`, 'i').test(value));

  return (
    <div className="relative">
      {menuOpen && skillQuery !== null && (
        <div
          className="popover-in border-border-hairline bg-bg-1 shadow-float absolute right-0 bottom-full left-0 z-10 mb-2 flex max-h-72 flex-col overflow-y-auto rounded-card border p-1.5"
          data-testid="skills-palette"
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

      {mentioning && (
        // Who you might mean, in the same pill language: ↑/↓ moves, Tab or ↵ picks.
        <div
          className="mb-2 flex items-center gap-2 overflow-x-auto px-1 [scrollbar-width:none]"
          role="listbox"
          data-testid="mention-palette"
        >
          {items.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={item.apply}
              ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined}
              className={cn(
                'popover-in shadow-float flex h-[30px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap backdrop-blur-md transition-colors',
                i === active
                  ? 'border-border-strong bg-[var(--pill-fill)] text-text-primary'
                  : 'border-border-hairline border-dashed bg-[var(--pill-fill)]/60 text-text-secondary'
              )}
            >
              <span className="flex size-5 items-center justify-center">{item.icon}</span>
              <span>@{item.label}</span>
              {i === active && item.detail && <span className="text-text-muted">{item.detail}</span>}
              {i === active && (
                <kbd className="border-border-strong ml-0.5 rounded border px-1 font-mono text-2xs leading-4 text-text-muted">Tab</kbd>
              )}
            </button>
          ))}
        </div>
      )}

      {!menuOpen && (ownPill || replyPill || agentPill || docPill) && (
        // In the flow, above the input: the Room makes room for it rather than being covered.
        <div className="popover-in mb-2 flex flex-wrap items-center gap-2 px-1" data-testid="composer-pills">
          {ownPill && (
            // Your agent without an @: one pill, no pickers (it runs as it last ran).
            <ContextPill
              reason={ownPill.reason}
              onDismiss={dropSuggestion}
              dismissLabel="Send to the chat"
              testId="composer-own-agent-pill"
            >
              {ownPill.replyTo && <CornerUpLeft className="size-3.5 shrink-0" strokeWidth={1.5} />}
              <span className="card-pop-in flex">
                <BrandLogo id={agentLogoId(ownPill.agent)} size={14} />
              </span>
              <b className="font-medium text-text-primary">{AGENT_NAME[ownPill.agent]}</b>
              {ownPill.replyTo && <span className="max-w-56 truncate">{ownPill.replyTo.excerpt}</span>}
            </ContextPill>
          )}
          {replyPill && (
            <ContextPill reason="You pressed Reply" onDismiss={onCancelReply} dismissLabel="Not a reply" testId="composer-reply">
              <CornerUpLeft className="size-3.5 shrink-0" strokeWidth={1.5} />
              <span>Replying to</span>
              <b className="font-medium text-text-primary">{replyPill.label}</b>
              <span className="max-w-56 truncate">{replyPill.excerpt}</span>
            </ContextPill>
          )}
          {agentPill && (
            <ContextPill
              reason={`You tagged @${agentPill}`}
              onDismiss={() => setDroppedAgent(true)}
              dismissLabel="Send as a plain message"
              testId="composer-agent-pill"
            >
              <span className="card-pop-in flex">
                <BrandLogo id={agentLogoId(agentPill)} size={14} />
              </span>
              <b className="font-medium text-text-primary">{AGENT_NAME[agentPill]}</b>
              <span className="size-[3px] rounded-full bg-text-muted/60" aria-hidden />
              <AgentSettings agent={agentPill} model={agentModels?.[agentPill] ?? null} prefetch />
            </ContextPill>
          )}
          {docPill && (
            <ContextPill
              reason="It's open beside the chat"
              onDismiss={() => setDroppedDoc(true)}
              dismissLabel="Don't attach"
              testId="composer-doc-pill"
            >
              <FileText className="size-3.5 shrink-0" strokeWidth={1.5} />
              <span>With</span>
              <b className="font-medium text-text-primary">{docPill.split('/').pop()}</b>
            </ContextPill>
          )}
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
            if (e.key === 'Escape' && ownPill) {
              e.preventDefault();
              dropSuggestion();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={replyTo ? `Reply to ${replyTo.label}` : `Message ${spaceName}`}
          rows={1}
          // Grows with what you type (field-sizing: content), up to 40% of the window, then scrolls.
          className="placeholder:text-text-muted min-h-[40px] max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-3.5 py-2.5 text-sm text-text-primary outline-none [field-sizing:content]"
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
            {sendsTo ? `Ask ${AGENT_NAME[sendsTo]}` : replyPill ? 'Reply' : 'Send'}
            <CornerDownLeft className="size-3" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
