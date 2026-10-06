import { AtSign, Check, ChevronDown, CornerDownLeft, CornerUpLeft, FileText, Paperclip, Smile, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { WILL_SEND_WHEN_ONLINE } from '@renderer/features/home/home-connection';
import { cn } from '@renderer/lib/utils';
import { formatFileTag, rankTaggableFiles, type TaggableFile } from '@shared/rig/file-tags';
import { isLargeBatch, type ComposerAttachment } from '../attachments';
import { formatMarkerFor, toggleMarker } from '../composer-format';
import { loadEmojiIndex, matchShortcodes, recordEmojiUse, type EmojiIndex } from '../emoji-data';
import { agentLogoId, BrandLogo } from '../logos';
import { decideSend, type ComposerRoute, type SendOverride } from '../send-decision';
import type { ComposerAttachments } from '../use-composer-attachments';
import { Button } from '@renderer/lib/ui/button';
import { IdentityAvatar } from '@renderer/lib/ui/identity-avatar';
import { AttachmentChips } from './attachment-chips';
import { applyMentionText, foldName, mentionQueryOf, nameMatches, presentMentions, type MentionPerson } from '../mentions';
import { SOMEONE } from '../person-identity';
import type { AgentKind, MessageMention, RoomAgent, RoomMember, RoomReplyRef, RoomSkill } from '../types';
import { AgentSettings } from './agent-settings';
import { ContextPill } from './context-pill';
import { EmojiPickerPopover } from './reactions';
import { AGENT_NAME, AgentAvatar, PersonAvatar } from './identity';

const TYPING_IDLE_MS = 4000;
/** The `+` tag being typed at the end of the draft: group 1 a quoted name so far, group 2 a plain one. */
const FILE_QUERY = /(?:^|\s)\+(?:"([^"\n]*)|([^\s"]*))$/;
/**
 * An emoji shortcode being typed at the end of the draft: `:` at the start or
 * after a space, then at least two letters. So a time (10:30), a link
 * (https://…) or "Note: …" never opens it.
 */
export const EMOJI_QUERY = /(?:^|\s):([a-z]{2}[a-z0-9_+-]*)$/i;
const DRAFT_PREFIX = 'rig-room-draft:';
/** A typing pause this long asks whether the draft answers your agent. */
const SUGGEST_DEBOUNCE_MS = 500;
/** How sure the relay must be before the draft goes to your agent by default. */
export const SUGGEST_MIN_CONFIDENCE = 0.5;

/**
 * Spaces: the Room's composer. `/` at the start opens the space's skills,
 * `@` opens people and agents (agents first, each labelled); both menus
 * filter as you type, move with ↑/↓, pick with ↵ or Tab and close with Esc.
 * `:` and two letters opens matching emoji the same way (↵ puts the emoji
 * itself in, not its shortcode); the smiley button opens the emoji picker,
 * which inserts at the cursor.
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
 *
 * The same pause also brings the relay's routing: when it says the draft is
 * for your agent, the button reads "Ask Claude" and Enter asks it, with no
 * pill. The button's chevron flips that for the draft (ask one of your
 * agents, or just send); see `send-decision.ts`. Without routing (offline,
 * an older relay) the button works as it always did.
 */

/** What the composer understood about a message, sent along with its text. */
/** The composer's guess that a plain draft answers your own agent's turn. */
export type ComposerSuggestion = { agent: AgentKind; replyTo: RoomReplyRef; confidence: number };
/** What a typing pause learned about the draft: the turn it answers, and the relay's routing (null from a relay that doesn't route). */
export type ComposerPreview = { reply: ComposerSuggestion | null; route: ComposerRoute | null };

/** Any @mention, of an agent or a person (an email's `x@y.com` isn't one). */
function hasMention(text: string): boolean {
  return /(^|\s)@[\p{L}\p{N}_-]+/u.test(text);
}

/**
 * Which of your agents the draft @-tags: the first one written, as the
 * relay's dispatcher reads it too ("@codex, look at what @claude said" asks
 * Codex). A tag ends at anything that can't be in a name ("@codex," counts).
 */
function taggedAgent(text: string, agents: readonly RoomAgent[]): AgentKind | null {
  for (const m of text.matchAll(/(?:^|\s)@([a-z0-9_-]+)/gi)) {
    const agent = agents.find((a) => a.agent === m[1]!.toLowerCase())?.agent;
    if (agent) return agent;
  }
  return null;
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
  /** Files attached on chips (copied into the space when the message is sent). */
  files?: ComposerAttachment[];
  /** A thread reply that also goes to the main column (the thread panel's "Also send to #space"; the composer itself never sets it). */
  alsoInChannel?: boolean;
  /** You chose to just send what the relay would have taken to your agent: the router leaves it alone. */
  route?: 'none';
  /** The people you tagged by picking them, still in the text (`meta.mentions`). */
  mentions?: MessageMention[];
};

/** A person you picked in the `@` menu: who, and whether they're in the space. */
type MentionPick = MessageMention & { group: 'member' | MentionPerson['group'] };

/** "#launch-plan", whether or not the name came with its "#". */
function hashName(spaceName: string): string {
  return spaceName.startsWith('#') ? spaceName : `#${spaceName}`;
}

/** "Jérémie", "Jérémie and Sam", "Jérémie, Sam and Ana". */
function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

type MenuItem = {
  key: string;
  section?: string;
  icon: ReactNode;
  label: string;
  detail: string;
  /** Always shown beside the label ("Invited"). */
  tag?: string;
  apply: () => void;
};

/** The `@` row's people groups, labelled in the row; agents need no label (their logo says it). */
const IN_SPACE = 'In this space';
const OUTSIDE = 'Your people, not in this space';

function readDraft(key: string | undefined): string {
  if (!key) return '';
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

/** A message that failed to send after you'd left its space: it's waiting in that space's message box when you're back (never over a draft you've since started). */
export function keepUnsentAsDraft(key: string, text: string): void {
  if (!readDraft(key).trim()) writeDraft(key, text);
}

/** A draft kept under one key (a space still being set up) moves to another (its binding id), unless one is already there. */
export function moveComposerDraft(from: string, to: string): void {
  const text = readDraft(from);
  if (!text.trim()) return;
  keepUnsentAsDraft(to, text);
  writeDraft(from, '');
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
  availableAgents,
  attachments,
  waitForConnection = false,
  waitingNote = WILL_SEND_WHEN_ONLINE,
  listFiles,
  placeholder,
  footer,
  autoFocus = false,
  people = [],
  onInvitePerson,
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
  /** Whether a plain draft answers one of your own agent's turns, and the relay's routing for it; null when it can't tell. */
  suggestReply?: (draft: string) => Promise<ComposerPreview | null>;
  /** Your agents that can run on this computer, offered in the send button's menu; all of `agents` without it. */
  availableAgents?: readonly AgentKind[];
  /** The files waiting to go with the message; no paperclip without it. */
  attachments?: ComposerAttachments;
  /** The space's files, for `+` tags; no file suggestions without it. */
  listFiles?: () => Promise<TaggableFile[]>;
  /**
   * No connection to the relay: a message sent now stays in the box, text and
   * files, and goes by itself once the connection is back.
   */
  waitForConnection?: boolean;
  /** What a message waiting on `waitForConnection` says (a new space: once it's ready). */
  waitingNote?: string;
  /** The empty box's words when not replying to anyone (the thread panel's "Reply in thread"); "Message #space" without it. */
  placeholder?: string;
  /** Under the box (the thread panel's "Also send to #space"). */
  footer?: ReactNode;
  /** Focus the box when it appears (a thread just opened). */
  autoFocus?: boolean;
  /** Who else `@` offers: people invited to the space, and your people who aren't in it. */
  people?: readonly MentionPerson[];
  /** Invites someone tagged from outside the space ("Invite and send"); resolves to whether it worked. No offer without it. */
  onInvitePerson?: (person: MessageMention) => Promise<boolean>;
}) {
  const [value, setValue] = useState(() => readDraft(draftKey));
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // Pills you dropped for this message; a fresh message starts clean.
  const [droppedAgent, setDroppedAgent] = useState(false);
  const [droppedDoc, setDroppedDoc] = useState(false);
  // What the last typing pause learned about this draft: the turn it may
  // answer, and the relay's routing. Kept while a newer answer is on its
  // way, so the button doesn't flicker as you type.
  const [preview, setPreview] = useState<{ draft: string; reply: ComposerSuggestion | null; route: ComposerRoute | null } | null>(null);
  // Your choice in the send button's menu, for this draft. Dropping the
  // no-@ pill is the same as choosing Send (one × for "not to my agent").
  const [override, setOverride] = useState<SendOverride | null>(null);
  const droppedSuggestion = override?.kind === 'send';
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  useEffect(() => {
    if (value.trim()) return;
    setDroppedAgent(false);
    setDroppedDoc(false);
    setOverride(null);
    setSendMenuOpen(false);
  }, [value]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(readDraft(draftKey));
    setPicks([]);
  }, [draftKey]);
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
  // Once you've chosen in the menu (or dropped the pill) nothing more is
  // asked, and the last answer stays: a Send can still tell the router.
  useEffect(() => {
    const draft = value.trim();
    if (override && draft) return;
    if (!suggestReply || replyTo || !draft || draft.startsWith('/') || hasMention(draft)) {
      setPreview(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void suggestReply(draft)
        .catch(() => null)
        .then((answer) => {
          if (stale) return;
          setPreview(answer ? { draft, reply: answer.reply, route: answer.route } : null);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [value, suggestReply, replyTo, override]);

  const skillQuery = /^\/(\S*)$/.exec(value)?.[1] ?? null;
  // Everyone `@` can name: a whole name followed by a space is a finished tag.
  const mentionNames = useMemo(
    () => [...agents.map((a) => a.agent), ...members.map((m) => m.name), ...people.map((p) => p.name)],
    [agents, members, people]
  );
  const mentionQuery = useMemo(() => mentionQueryOf(value, mentionNames), [value, mentionNames]);
  // The people you've picked for this draft; the ones still written go with it (`presentMentions`).
  const [picks, setPicks] = useState<MentionPick[]>([]);
  // Tagged from outside the space and you chose "Send only" (or invited them): no more offer for them.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const [inviting, setInviting] = useState(false);
  useEffect(() => {
    if (value.trim()) return;
    setPicks([]);
    setSettled(new Set());
  }, [value]);
  // `+` at the start or after a space: tag a file in the space (`shared/rig/file-tags.ts`); `+"` starts a quoted name.
  const fileQuery = useMemo(() => {
    if (!listFiles) return null;
    const m = FILE_QUERY.exec(value);
    return m ? (m[1] ?? m[2] ?? '') : null;
  }, [value, listFiles]);
  // The space's files, read when a `+` opens the list (again on each new `+`).
  const [spaceFiles, setSpaceFiles] = useState<TaggableFile[] | null>(null);
  const tagging = fileQuery !== null;
  useEffect(() => {
    if (!tagging || !listFiles) return;
    let alive = true;
    void listFiles()
      .catch(() => [] as TaggableFile[])
      .then((files) => alive && setSpaceFiles(files));
    return () => {
      alive = false;
    };
  }, [tagging, listFiles]);
  const applyFileTag = (relPath: string) => {
    const tag = formatFileTag(relPath);
    if (!tag) return;
    setValue((current) => current.replace(FILE_QUERY, (m) => `${/^\s/.test(m) ? m[0] : ''}${tag} `));
    textareaRef.current?.focus();
  };

  // `:ta` → 🎉 :tada:. The emoji data loads the first time a shortcode is typed.
  const emojiQuery = useMemo(() => EMOJI_QUERY.exec(value)?.[1] ?? null, [value]);
  const [emojiIndex, setEmojiIndex] = useState<EmojiIndex | null>(null);
  const wantsEmoji = emojiQuery !== null;
  useEffect(() => {
    if (!wantsEmoji || emojiIndex) return;
    let alive = true;
    loadEmojiIndex().then(
      (index) => alive && setEmojiIndex(index),
      () => undefined
    );
    return () => {
      alive = false;
    };
  }, [wantsEmoji, emojiIndex]);
  const applyEmoji = (emoji: string) => {
    recordEmojiUse(emoji);
    setValue((current) => current.replace(EMOJI_QUERY, (m) => `${/^\s/.test(m) ? m[0] : ''}${emoji} `));
    textareaRef.current?.focus();
  };
  // The picker puts its emoji where the cursor was when it opened.
  const smileyRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const openPicker = () => {
    const el = textareaRef.current;
    selectionRef.current = el ? { start: el.selectionStart, end: el.selectionEnd } : null;
    setPicking((p) => !p);
  };
  const insertEmoji = (emoji: string) => {
    recordEmojiUse(emoji);
    setPicking(false);
    const at = selectionRef.current ?? { start: value.length, end: value.length };
    const next = value.slice(0, at.start) + emoji + value.slice(at.end);
    const caret = at.start + emoji.length;
    setValue(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  // ⌘B / ⌘I / ⌘E: markdown markers around the selection, kept in the field's own undo history.
  const formatSelection = (marker: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const edit = toggleMarker(el.value, el.selectionStart, el.selectionEnd, marker);
    el.setSelectionRange(edit.from, edit.to);
    const done = edit.insert
      ? document.execCommand('insertText', false, edit.insert)
      : edit.from === edit.to || document.execCommand('delete');
    if (!done) {
      const next = el.value.slice(0, edit.from) + edit.insert + el.value.slice(edit.to);
      setValue(next);
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(edit.selStart, edit.selEnd));
      return;
    }
    el.setSelectionRange(edit.selStart, edit.selEnd);
  };

  const applyMention = (label: string, pick?: MentionPick) => {
    setValue((current) => applyMentionText(current, label));
    if (pick) setPicks((current) => [...current.filter((p) => p.id !== pick.id), pick]);
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
    if (emojiQuery !== null) {
      return emojiIndex
        ? matchShortcodes(emojiIndex, emojiQuery).map(({ entry, shortcode }) => ({
            key: `emoji-${entry.emoji}`,
            icon: <span className="text-base leading-none">{entry.emoji}</span>,
            label: `:${shortcode}:`,
            detail: '',
            apply: () => applyEmoji(entry.emoji),
          }))
        : [];
    }
    if (fileQuery !== null) {
      return rankTaggableFiles(spaceFiles ?? [], fileQuery)
        .filter((file) => formatFileTag(file.relPath) !== null)
        .map((file) => {
          const folder = file.relPath.includes('/') ? file.relPath.slice(0, file.relPath.lastIndexOf('/')) : '';
          return {
            key: `file-${file.relPath}`,
            icon: <FileText className="size-3.5 text-text-muted" strokeWidth={1.5} />,
            label: file.name,
            detail: folder,
            apply: () => applyFileTag(file.relPath),
          };
        });
    }
    if (mentionQuery !== null) {
      const q = foldName(mentionQuery);
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
      const memberIds = new Set(members.map((m) => m.id));
      const memberItems: MenuItem[] = members
        .filter((m) => m.status === 'here' && m.name !== SOMEONE && nameMatches(m.name, mentionQuery))
        .map((m) => ({
          key: `person-${m.id}`,
          section: IN_SPACE,
          icon: <PersonAvatar member={m} size="sm" />,
          label: m.name,
          detail: m.online === false ? 'away' : m.online ? 'here now' : '',
          apply: () => applyMention(m.name, { id: m.id, name: m.name, group: 'member' }),
        }));
      const personItem = (p: MentionPerson): MenuItem => ({
        key: `${p.group}-${p.id}`,
        section: p.group === 'invited' ? IN_SPACE : OUTSIDE,
        icon: <IdentityAvatar name={p.name} avatarUrl={p.avatarUrl} sizeClassName="size-5" />,
        label: p.name,
        detail: p.detail ?? '',
        ...(p.group === 'invited' ? { tag: 'Invited' } : {}),
        apply: () => applyMention(p.name, { id: p.id, name: p.name, group: p.group }),
      });
      const others = people.filter((p) => !memberIds.has(p.id) && p.name.trim() && nameMatches(p.name, mentionQuery));
      return [
        ...agentItems,
        ...memberItems,
        ...others.filter((p) => p.group === 'invited').map(personItem),
        ...others.filter((p) => p.group === 'outside').map(personItem),
      ];
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillQuery, mentionQuery, fileQuery, emojiQuery, emojiIndex, spaceFiles, skills, members, agents, busyAgents, people]);

  const menuOpen = items.length > 0 && dismissedFor !== value;
  // Skills, files and emoji open the list above the input; people and agents the pill row.
  const listMenu = skillQuery !== null || fileQuery !== null || emojiQuery !== null;
  const mentioning = menuOpen && !listMenu;
  useEffect(() => setActive(0), [skillQuery, mentionQuery, fileQuery, emojiQuery]);

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

  // Your agent is tagged once its @name is written out, and a tag always
  // beats the no-@ pill; dropping the pill sends the message as plain chat.
  const tagged = taggedAgent(value, agents);
  // A relay that routes says when the reply goes to your agent (`ask`); an
  // older one only says how sure it is.
  const reply = preview?.reply ?? null;
  const replyConfident =
    !!reply &&
    (preview?.route
      ? preview.route.action === 'ask' && preview.route.agent === reply.agent
      : reply.confidence >= SUGGEST_MIN_CONFIDENCE);
  // Only a guess about your own agent, and only while it's still this draft.
  const suggested =
    reply &&
    replyConfident &&
    !droppedSuggestion &&
    !replyTo &&
    !hasMention(value) &&
    agents.some((a) => a.agent === reply.agent) &&
    sameDraft(preview!.draft, value.trim())
      ? reply
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
  const agentPill = tagged && !droppedAgent ? tagged : null;
  const replyPill = replyTo ?? null;
  const docPill = agentPill && openDoc && !droppedDoc ? openDoc : null;
  // The pill stays only while it's still where the message goes (another agent chosen in the menu drops it).
  const shownOwnPill = ownPill && (override?.kind !== 'agent' || override.agent === ownPill.agent) ? ownPill : null;
  const decision = decideSend({
    text: value,
    ownAgents: agents.map((a) => a.agent),
    tagged: agentPill,
    pill: shownOwnPill?.agent ?? null,
    route: preview?.route ?? null,
    override,
    replying: !!replyPill,
  });
  const sendsTo = decision.agent;
  const dropSuggestion = () => {
    setOverride({ kind: 'send' });
    textareaRef.current?.focus();
  };
  // The send button's menu: your agents that can run here, then Send.
  const menuAgents = (availableAgents ?? agents.map((a) => a.agent)).filter((agent) => agents.some((a) => a.agent === agent));
  const choose = (choice: SendOverride) => {
    setOverride(choice);
    setSendMenuOpen(false);
    textareaRef.current?.focus();
  };

  const chips = attachments?.chips ?? [];
  const hasFiles = chips.length > 0;
  // Many files, or a lot of bytes, ask once before going.
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  useEffect(() => setConfirmingBatch(false), [chips.length]);
  const held = hasFiles && !!attachments?.holdReason;
  const canSend = (!!value.trim() || hasFiles) && !held;
  // Sent while the files' checks are still out: it goes as soon as they're in (or not, if one comes back red).
  const [waitingToSend, setWaitingToSend] = useState(false);
  // Sent with no connection: it waits here, as typed, and goes once it's back.
  const [waitingForConnection, setWaitingForConnection] = useState(false);
  const send = () => {
    const trimmed = value.trim();
    if (!trimmed && !hasFiles) return;
    if (held) return;
    if (waitForConnection) {
      setWaitingForConnection(true);
      return;
    }
    setWaitingForConnection(false);
    if (hasFiles && attachments?.pending) {
      setWaitingToSend(true);
      return;
    }
    setWaitingToSend(false);
    if (hasFiles && isLargeBatch(chips) && !confirmingBatch) {
      setConfirmingBatch(true);
      return;
    }
    const files = hasFiles ? attachments!.clear() : undefined;
    const mentions = presentMentions(trimmed, picks);
    onSend(trimmed, {
      replyTo: replyPill ?? shownOwnPill?.replyTo ?? undefined,
      agent: trimmed ? sendsTo : null,
      attach: docPill,
      ...(trimmed && decision.meta.route ? { route: decision.meta.route } : {}),
      ...(files ? { files } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    });
    setValue('');
    setPreview(null);
    setTyping(false);
    setConfirmingBatch(false);
  };

  const sendRef = useRef(send);
  sendRef.current = send;
  const filesReady = !!attachments?.ready;
  useEffect(() => {
    if (!waitingToSend) return;
    if (!hasFiles || held) setWaitingToSend(false);
    else if (filesReady) sendRef.current();
  }, [waitingToSend, filesReady, held, hasFiles]);
  const hasDraft = !!value.trim() || hasFiles;
  useEffect(() => {
    if (!waitingForConnection) return;
    // Cleared out meanwhile: nothing left to send.
    if (!hasDraft) setWaitingForConnection(false);
    else if (!waitForConnection) sendRef.current();
  }, [waitingForConnection, waitForConnection, hasDraft]);

  const mentionedBusy = busyAgents.find((agent) => new RegExp(`@${agent}\\b`, 'i').test(value));

  // Tagged from your people but not in the space: they won't see it. One
  // offer above the box, until you invite them or choose to send anyway
  // (Enter sends without inviting, the same as "Send only").
  const outsiders = onInvitePerson
    ? presentMentions(
        value,
        picks.filter((p) => p.group === 'outside' && !settled.has(p.id) && !members.some((m) => m.id === p.id))
      )
    : [];
  const settle = (ids: readonly string[]) => setSettled((current) => new Set([...current, ...ids]));
  const inviteAndSend = async () => {
    if (!onInvitePerson || inviting || outsiders.length === 0) return;
    setInviting(true);
    const invited = await Promise.all(outsiders.map((p) => onInvitePerson(p).catch(() => false)));
    setInviting(false);
    settle(outsiders.filter((_, i) => invited[i]).map((p) => p.id));
    // Sent only once everyone tagged is invited; otherwise the draft waits (the room says what failed).
    if (invited.every(Boolean)) sendRef.current();
  };
  const sendOnly = () => {
    settle(outsiders.map((p) => p.id));
    send();
  };

  return (
    <div className="relative">
      {menuOpen && listMenu && (
        <div
          className="popover-in border-border-hairline bg-bg-1 shadow-float absolute right-0 bottom-full left-0 z-10 mb-2 flex max-h-72 flex-col overflow-y-auto rounded-card border p-1.5"
          data-testid="skills-palette"
          role="listbox"
        >
          <p className="px-2 pt-1 pb-1 text-2xs text-text-muted">
            {skillQuery !== null ? 'Skills in this space' : emojiQuery !== null ? 'Emoji' : 'Files in this space'}
          </p>
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
                  {listMenu ? item.label : `@${item.label}`}
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
          {items.map((item, i) => [
            item.section && item.section !== 'Agents' && item.section !== items[i - 1]?.section && (
              <span key={`label-${item.section}`} className="shrink-0 pl-1 text-2xs whitespace-nowrap text-text-muted" aria-hidden>
                {item.section}
              </span>
            ),
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
              {item.tag && (
                <span className="border-border-hairline rounded-full border px-1.5 text-2xs leading-4 text-text-muted">{item.tag}</span>
              )}
              {i === active && item.detail && <span className="text-text-muted">{item.detail}</span>}
              {i === active && (
                <kbd className="border-border-strong ml-0.5 rounded border px-1 font-mono text-2xs leading-4 text-text-muted">Tab</kbd>
              )}
            </button>,
          ])}
        </div>
      )}

      {!menuOpen && outsiders.length > 0 && (
        <div
          className="popover-in border-border-hairline bg-bg-1 shadow-float mb-2 flex items-center gap-2.5 rounded-card border px-3 py-2"
          role="status"
          data-testid="composer-outsider-notice"
        >
          <IdentityAvatar
            name={outsiders[0]!.name}
            avatarUrl={people.find((p) => p.id === outsiders[0]!.id)?.avatarUrl ?? null}
            sizeClassName="size-5"
          />
          <span className="min-w-0 flex-1 text-xs text-text-secondary">
            {outsiders.length === 1
              ? `${outsiders[0]!.name} isn’t in ${hashName(spaceName)} and won’t see this. Invite ${outsiders[0]!.name}?`
              : `${joinNames(outsiders.map((p) => p.name))} aren’t in ${hashName(spaceName)} and won’t see this. Invite them?`}
          </span>
          <Button
            size="xs"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void inviteAndSend()}
            disabled={inviting}
            aria-busy={inviting || undefined}
            data-testid="composer-invite-and-send"
          >
            Invite and send
          </Button>
          <Button
            size="xs"
            variant="outline"
            onMouseDown={(e) => e.preventDefault()}
            onClick={sendOnly}
            disabled={inviting}
            data-testid="composer-send-only"
          >
            Send only
          </Button>
        </div>
      )}

      {!menuOpen && (shownOwnPill || replyPill || agentPill || docPill) && (
        // In the flow, above the input: the Room makes room for it rather than being covered.
        <div className="popover-in mb-2 flex flex-wrap items-center gap-2 px-1" data-testid="composer-pills">
          {shownOwnPill && (
            // Your agent without an @: one pill, no pickers (it runs as it last ran).
            <ContextPill
              reason={shownOwnPill.reason}
              onDismiss={dropSuggestion}
              dismissLabel="Send to the chat"
              testId="composer-own-agent-pill"
            >
              {shownOwnPill.replyTo && <CornerUpLeft className="size-3.5 shrink-0" strokeWidth={1.5} />}
              <span className="card-pop-in flex">
                <BrandLogo id={agentLogoId(shownOwnPill.agent)} size={14} />
              </span>
              <b className="font-medium text-text-primary">{AGENT_NAME[shownOwnPill.agent]}</b>
              {shownOwnPill.replyTo && <span className="max-w-56 truncate">{shownOwnPill.replyTo.excerpt}</span>}
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
        {attachments && <AttachmentChips attachments={attachments} />}
        <textarea
          ref={textareaRef}
          onPaste={(e) => {
            // An image (or files copied in Finder) with no text: attach it instead of pasting nothing.
            if (!attachments || attachments.disabledReason) return;
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0 || e.clipboardData.getData('text/plain')) return;
            e.preventDefault();
            void attachments.addFiles(files);
          }}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setTyping(e.target.value.trim().length > 0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            const marker = formatMarkerFor(e, /Mac/i.test(navigator.platform));
            if (marker) {
              e.preventDefault();
              formatSelection(marker);
              return;
            }
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
            if (e.key === 'Escape' && sendMenuOpen) {
              e.preventDefault();
              setSendMenuOpen(false);
              return;
            }
            if (e.key === 'Escape' && shownOwnPill) {
              e.preventDefault();
              dropSuggestion();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={replyTo ? `Reply to ${replyTo.label}` : (placeholder ?? `Message ${spaceName}`)}
          autoFocus={autoFocus}
          rows={1}
          // Grows with what you type (field-sizing: content), up to 40% of the window, then scrolls.
          className="placeholder:text-text-muted min-h-[40px] max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-3.5 py-2.5 text-sm text-text-primary outline-none [field-sizing:content]"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <button
            type="button"
            aria-label="Attach files"
            // Not `disabled`: a disabled button shows no tooltip, and the tooltip says why.
            aria-disabled={!attachments || !!attachments.disabledReason}
            title={attachments?.disabledReason ?? 'Attach files'}
            onClick={() => {
              if (attachments && !attachments.disabledReason) void attachments.pick();
            }}
            className={cn(
              'flex size-7 items-center justify-center rounded-control text-text-muted transition-colors',
              attachments && !attachments.disabledReason ? 'hover:bg-bg-2' : 'cursor-default opacity-50'
            )}
            data-testid="composer-attach"
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
          <button
            ref={smileyRef}
            type="button"
            aria-label="Emoji"
            title="Emoji"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openPicker}
            className="hover:bg-bg-2 flex size-7 items-center justify-center rounded-control text-text-muted transition-colors"
            data-testid="composer-emoji"
          >
            <Smile className="size-3.5" strokeWidth={1.5} />
          </button>
          <EmojiPickerPopover anchor={smileyRef} open={picking} onClose={() => setPicking(false)} onPick={insertEmoji} align="left" />
          {waitingForConnection ? (
            <span className="ml-1 flex items-center gap-1.5 text-xs text-text-muted" data-testid="composer-waiting-connection">
              {waitingNote}
              <button
                type="button"
                onClick={() => setWaitingForConnection(false)}
                className="text-text-secondary hover:text-text-primary underline"
              >
                Don&rsquo;t send
              </button>
            </span>
          ) : mentionedBusy && (
            <span className="ml-1 text-xs text-text-muted" data-testid="composer-queue-note">
              Your {AGENT_NAME[mentionedBusy]} is working; this goes after its current turn.
            </span>
          )}
          <SendButton
            label={confirmingBatch ? `Send ${chips.length} files?` : decision.label}
            onSend={send}
            disabled={!canSend || waitingToSend || waitingForConnection}
            busy={waitingToSend || waitingForConnection}
            active={canSend}
            title={held ? (attachments?.holdReason ?? undefined) : undefined}
            // A tag already says where it goes; the menu is for everything else.
            choices={!!value.trim() && !agentPill && !confirmingBatch && !waitingForConnection ? menuAgents : null}
            chosen={decision.mode === 'ask' ? decision.agent : 'send'}
            open={sendMenuOpen}
            onOpenChange={setSendMenuOpen}
            onChoose={choose}
          />
        </div>
      </div>
      {footer}
    </div>
  );
}

/**
 * The composer's send button, split when there's a choice to make: the
 * chevron opens a small menu above it (ask one of your agents, or just
 * send), and the choice sticks for the draft.
 */
function SendButton({
  label,
  onSend,
  disabled,
  busy,
  active,
  title,
  choices,
  chosen,
  open,
  onOpenChange,
  onChoose,
}: {
  label: string;
  onSend: () => void;
  disabled: boolean;
  busy: boolean;
  active: boolean;
  title?: string;
  /** Your agents to offer; null for no menu. */
  choices: readonly AgentKind[] | null;
  chosen: AgentKind | 'send' | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: SendOverride) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const split = !!choices && choices.length > 0;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!split && open) onOpenChange(false);
  }, [split, open, onOpenChange]);
  const tone = active ? 'bg-accent text-accent-ink' : 'bg-bg-2 text-text-secondary';
  const option = (key: string, selected: boolean, onClick: () => void, children: ReactNode) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-testid={`composer-send-option-${key}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="hover:bg-bg-2 flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm text-text-primary transition-colors"
    >
      {children}
      {selected && <Check className="ml-auto size-3.5 shrink-0 text-text-muted" strokeWidth={1.5} />}
    </button>
  );
  return (
    <div ref={wrapRef} className="relative ml-auto flex">
      {split && open && (
        <div
          role="menu"
          data-testid="composer-send-menu"
          className="popover-in border-border-hairline bg-bg-1 shadow-float absolute right-0 bottom-full z-10 mb-1.5 flex min-w-40 flex-col rounded-card border p-1"
        >
          {choices.map((agent) =>
            option(agent, chosen === agent, () => onChoose({ kind: 'agent', agent }), (
              <>
                <BrandLogo id={agentLogoId(agent)} size={14} />
                <span>Ask {AGENT_NAME[agent]}</span>
              </>
            ))
          )}
          {option('send', chosen === 'send', () => onChoose({ kind: 'send' }), (
            <>
              <CornerDownLeft className="size-3.5 text-text-muted" strokeWidth={1.5} />
              <span>Send</span>
            </>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onSend}
        disabled={disabled}
        aria-busy={busy || undefined}
        title={title}
        data-testid="composer-send"
        className={cn(
          'flex h-6.5 items-center gap-1.5 rounded-control px-2.5 text-xs transition-colors disabled:opacity-60',
          split && 'rounded-r-none',
          tone
        )}
      >
        {label}
        <CornerDownLeft className="size-3" strokeWidth={1.5} />
      </button>
      {split && (
        <button
          type="button"
          aria-label="Choose where this goes"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Choose where this goes"
          data-testid="composer-send-menu-toggle"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpenChange(!open)}
          className={cn(
            'flex h-6.5 items-center rounded-control rounded-l-none border-l border-current/20 px-1 transition-colors',
            tone
          )}
        >
          <ChevronDown className="size-3" strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}
