import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  FilePen,
  Loader2,
  MessageSquare,
  PanelRightOpen,
  Play,
  Plus,
  Reply,
  RotateCcw,
  Send,
  Shuffle,
  Undo2,
  X,
} from 'lucide-react';
import {
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  memo,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { rpc } from '@renderer/lib/ipc';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { ActionButton } from './action-button';
import { Face, SessionMatrix, SourceLogo, sourceName } from './bits';
import { rectOf, useHome } from './home-context';
import { PEOPLE } from './mock';
import type { FeedChoice, FeedItem, FeedVerb, RailSession } from './model';
import { personFor } from './real-feed';
import { chosen, normalizeText, parseSay, sayParts, sayPlain, spaceLabel, stepChoice, VERB_LABEL } from './say';
import { type FeedEntry, findSession, type Rect, type SentResult } from './store';

/**
 * A Feed row and its parts: what's going on, what the choice does and (a send
 * or post) the exact words, the carousel, the action pill and its ▾ menu.
 * Home's Feed (`feed.tsx`) and the first run's First win step draw the same row.
 */

const VERB_ICON: Record<FeedVerb, typeof Play> = {
  reply: Reply,
  start: Play,
  space: Plus,
  open: Eye,
  send: Send,
  post: MessageSquare,
};

/** What the button says while a choice runs. */
const BUSY: Partial<Record<FeedVerb, string>> = { send: 'Sending…', post: 'Posting…' };

/** A Feed row on Home: the row itself, with Home's state and moves. */
export function FeedRow({ entry }: { entry: FeedEntry }) {
  const { spaces, dispatch, runItem, open, toast, answerCard } = useHome();
  const { item } = entry;
  const choice = chosen(item, entry.pick);
  const session = item.sessionId ? findSession(spaces, item.sessionId)?.session : undefined;
  const needs = item.group === 'needs_you';
  return (
    <FeedRowView
      entry={entry}
      where={spaceLabel(item, choice, spaces)}
      session={session}
      onRun={(rect) => runItem(item.id, rect)}
      onPick={(choiceId, slide) => dispatch({ type: 'pick', itemId: item.id, choiceId, slide })}
      onEdit={(text) => dispatch({ type: 'edit', itemId: item.id, text })}
      onEditDraft={(text) => dispatch({ type: 'edit-draft', itemId: item.id, text })}
      onReset={() => dispatch({ type: 'reset', itemId: item.id })}
      onOpenTitle={() =>
        session ? open({ kind: 'session', id: session.id }) : open({ kind: 'brief', itemId: item.id })
      }
      menu={menuItems(item, !!session)}
      onMenu={(key) => {
        if (key === 'open' && session) open({ kind: 'session', id: session.id });
        else if (key === 'brief') open({ kind: 'brief', itemId: item.id });
        else if (key === 'later') {
          answerCard(item.id, 'snooze');
          dispatch({ type: 'remove', itemId: item.id });
          toast(needs ? 'Reminder set for an hour' : 'Hidden until tomorrow');
        } else if (key === 'ignore') dispatch({ type: 'ignore', itemId: item.id, value: true });
      }}
      onOpenSent={(sent) => {
        if (sent.link) void rpc.app.openExternal(sent.link);
      }}
    />
  );
}

/**
 * A Feed row, drawn from its entry and told what to do by its owner: Home's
 * Feed (`FeedRow`), or the first run's First win step. The source and the
 * people, the title, what's going on and what the choice does, then (a send
 * or post) the exact words it sends, editable, with the carousel and the
 * action pill below. Sent, it becomes a done card; failed, it says why and
 * offers Retry.
 */
export function FeedRowView({
  entry,
  where,
  session,
  onRun,
  onPick,
  onEdit,
  onEditDraft,
  onReset,
  onOpenTitle,
  menu,
  onMenu,
  onOpenSent,
}: {
  entry: FeedEntry;
  /** The space or source label at the top left. */
  where: string;
  session?: RailSession;
  onRun: (from: Rect | null) => void;
  onPick: (choiceId: string, slide: 'left' | 'right') => void;
  onEdit: (text: string | null) => void;
  onEditDraft: (text: string | null) => void;
  onReset: () => void;
  onOpenTitle?: () => void;
  menu: MenuItem[];
  onMenu: (key: MenuKey) => void;
  /** A done card's Open: the message it sent, or the session it started. */
  onOpenSent?: (sent: SentResult) => void;
}) {
  const { item } = entry;
  const choice = chosen(item, entry.pick);
  const articleRef = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const needs = item.group === 'needs_you';

  if (entry.sent) return <SentRow entry={entry} onOpen={onOpenSent} />;

  const run = () => onRun(rectOf(articleRef.current));
  const pick = (to: FeedChoice) => {
    if (to.id === choice.id) return;
    const from = item.choices.indexOf(choice);
    onPick(to.id, item.choices.indexOf(to) < from ? 'right' : 'left');
  };
  const step = (by: number) => onPick(stepChoice(item, entry.pick, by).id, by < 0 ? 'right' : 'left');

  return (
    <div
      data-needs={needs}
      data-feed-id={item.id}
      className={cn(
        'hf-row border-border-hairline border-b px-5 py-3.5',
        entry.fresh && 'hf-arrive',
        menuOpen && 'z-20'
      )}
      style={menuOpen ? { position: 'relative' } : undefined}
    >
      <article ref={articleRef} className="grid min-w-0 gap-1.5">
        <div className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2">
          <span className="grid place-items-center">
            {session ? <SessionMatrix session={session} /> : <DotMatrix state="quiet" tone="mute" />}
          </span>
          <span className="truncate text-meta text-text-muted">{where}</span>
          <Stack item={item} />
        </div>
        <button
          type="button"
          onClick={onOpenTitle}
          className="ml-7 text-left text-base leading-[1.3] font-semibold text-text-primary decoration-border-strong underline-offset-[3px] hover:underline"
        >
          {item.title}
        </button>
        <Say entry={entry} choice={choice} onRun={run} onEdit={onEdit} />
        {choice.draft && <Draft entry={entry} choice={choice} onEdit={onEditDraft} />}
        {(entry.edited !== null || (entry.draftEdit ?? null) !== null) && (
          <div className="flex items-center pl-7 text-xs text-text-muted">
            <span className="mr-1">Edited</span>
            <ActionButton
              variant="quiet"
              size="sm"
              icon={Undo2}
              motion="undo"
              onClick={onReset}
              className="h-6 text-accent hover:bg-accent-subtle hover:text-accent"
            >
              Undo
            </ActionButton>
          </div>
        )}
        {entry.failed && (
          <p role="alert" className="ml-7 text-sm text-status-error" data-feed-failed>
            {choice.verb === 'post' ? "Couldn't post it" : "Couldn't send it"}: {entry.failed}
          </p>
        )}
        <div className="mt-1.5 flex items-center justify-end gap-2.5 pl-7">
          <Carousel item={item} choice={choice} onPick={pick} onStep={step} />
          <Action
            verb={choice.verb}
            label={entry.failed ? 'Retry' : undefined}
            busy={entry.starting ? (BUSY[choice.verb] ?? 'Starting…') : undefined}
            onRun={run}
            menuOpen={menuOpen}
            setMenuOpen={setMenuOpen}
            items={menu}
            onMenu={(key) => {
              setMenuOpen(false);
              onMenu(key);
            }}
          />
        </div>
      </article>
    </div>
  );
}

/**
 * The words a send or post would send, under the proposal: Claude's draft
 * until the person changes it. Drawn once per choice (and again on Undo), so
 * the caret never jumps while they type.
 */
function Draft({ entry, choice, onEdit }: { entry: FeedEntry; choice: FeedChoice; onEdit: (text: string | null) => void }) {
  const draft = choice.draft!;
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  return (
    <div className="ml-7 grid gap-1.5 rounded-r-[10px] border-l-2 border-accent bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-3 py-2" data-feed-draft>
      <span className="font-mono text-[10.5px] tracking-[0.08em] text-text-muted uppercase">{draft.label || 'Your reply'}</span>
      <DraftText
        renderKey={`${choice.id}:${entry.resetKey}:${draft.text}`}
        text={entry.draftEdit ?? draft.text}
        onInput={(text) => onEditRef.current(normalizeText(text) === normalizeText(draft.text) ? null : text)}
      />
    </div>
  );
}

const DraftText = memo(
  function DraftText({ text, onInput }: { renderKey: string; text: string; onInput: (text: string) => void }) {
    const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    };
    return (
      <div
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label="The words it sends; edit them before it goes"
        spellCheck
        onInput={(e) => onInput(e.currentTarget.innerText)}
        onPaste={onPaste}
        className="rounded-[6px] text-ui leading-[1.55] whitespace-pre-wrap text-text-primary outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        {text}
      </div>
    );
  },
  (a, b) => a.renderKey === b.renderKey
);

/** A send or post that went: what it did, where, and Open. */
function SentRow({ entry, onOpen }: { entry: FeedEntry; onOpen?: (sent: SentResult) => void }) {
  const sent = entry.sent!;
  return (
    <div className="hf-arrive border-b border-border-hairline px-5 py-3" data-feed-id={entry.item.id} data-feed-sent>
      <div className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 text-meta text-text-muted">
        <DotMatrix state="done" />
        <span>Claude did this · just now</span>
        <span />
      </div>
      <h4 className="mt-1 ml-7 text-ui font-semibold text-text-primary">{entry.item.title}</h4>
      <div className="mt-1 ml-7 flex items-center gap-2.5">
        <p className="min-w-0 flex-1 text-sm text-text-secondary">{sent.said}.</p>
        {(sent.link || sent.session) && onOpen && (
          <ActionButton variant="secondary" size="sm" icon={PanelRightOpen} onClick={() => onOpen(sent)}>
            Open
          </ActionButton>
        )}
      </div>
    </div>
  );
}

/** The source's logo, then the people involved, overlapping. */
function Stack({ item }: { item: FeedItem }) {
  // Demo people by key; anyone else Rig names gets a face from their name.
  const people = item.people.map((id) => PEOPLE[id] ?? (item.situationId ? personFor(id) : undefined)).filter((p): p is NonNullable<typeof p> => !!p);
  if (!item.source && !people.length) return <span />;
  return (
    <span className="hf-stack inline-flex items-center">
      {item.source && (
        <span
          title={['From ' + sourceName(item.source.connector), item.source.scope, item.source.ref].filter(Boolean).join(' · ')}
          className="grid size-5 place-items-center rounded-full bg-bg-1"
        >
          <SourceLogo connector={item.source.connector} size={20} />
        </span>
      )}
      {people.map((p) => (
        <Face key={p.id} person={p} size={20} />
      ))}
    </span>
  );
}

// ── the proposal text ──────────────────────────────────────────────────────

interface SayHandlers {
  onInput: (text: string) => void;
  onRun: () => void;
}

function Say({
  entry,
  choice,
  onRun,
  onEdit,
}: {
  entry: FeedEntry;
  choice: FeedChoice;
  onRun: () => void;
  onEdit: (text: string | null) => void;
}) {
  const { item } = entry;
  const handlers = useRef<SayHandlers>({ onInput: () => {}, onRun });
  handlers.current = {
    onRun,
    onInput: (text) => {
      const original = normalizeText(sayPlain(item, choice));
      const next = normalizeText(text);
      onEdit(next === original ? null : next);
    },
  };
  return (
    <div data-edited={entry.edited !== null} className="hf-say-wrap mt-1.5 ml-5">
      <EditableSay
        // A redrafted card (new words, same choice id) is drawn again.
        renderKey={`${choice.id}:${entry.resetKey}:${choice.lead}${choice.tail}${item.why}`}
        slide={entry.slide}
        item={item}
        choice={choice}
        handlers={handlers}
      />
    </div>
  );
}

/**
 * The editable text itself. Drawn once per choice (and again on Undo); while
 * someone types, React leaves the DOM alone, so the caret never jumps.
 */
const EditableSay = memo(
  function EditableSay({
    slide,
    item,
    choice,
    handlers,
  }: {
    renderKey: string;
    slide: 'left' | 'right' | null;
    item: FeedItem;
    choice: FeedChoice;
    handlers: RefObject<SayHandlers>;
  }) {
    const { lead, context, tail } = sayParts(item, choice);
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handlers.current?.onRun();
      }
    };
    const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    };
    return (
      <div
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label="What's going on and what Claude will do; edit to change it"
        spellCheck={false}
        data-slide={slide ?? undefined}
        onInput={(e) => handlers.current?.onInput(e.currentTarget.innerText)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="hf-say rounded-[8px] px-2 py-1.5 text-ui leading-[1.7]"
      >
        <b className="font-semibold text-text-primary">
          <SayText text={lead} notes={item.tokenNotes} />
        </b>{' '}
        <SayText text={context} notes={item.tokenNotes} />{' '}
        <SayText text={tail} notes={item.tokenNotes} />
      </div>
    );
  },
  (a, b) => a.renderKey === b.renderKey
);

function SayText({ text, notes }: { text: string; notes: Record<string, string> }) {
  return (
    <>
      {parseSay(text).map((seg, i) =>
        seg.kind === 'text' ? (
          seg.text
        ) : (
          <span
            key={i}
            contentEditable={false}
            data-kind={seg.token}
            title={notes[seg.text] ?? (seg.token === 'ref' ? 'Linear ticket' : undefined)}
            className="hf-tok"
          >
            {seg.text}
          </span>
        )
      )}
    </>
  );
}

// ── options and action ─────────────────────────────────────────────────────

/** Arrows and one dot per option; no labels, the bold first words say what each option is. */
function Carousel({
  item,
  choice,
  onPick,
  onStep,
}: {
  item: FeedItem;
  choice: FeedChoice;
  onPick: (c: FeedChoice) => void;
  onStep: (by: number) => void;
}) {
  if (item.choices.length < 2) return <span className="mr-auto" />;
  const at = item.choices.indexOf(choice);
  const arrow =
    'hf-nudge grid size-[26px] place-items-center rounded-full text-text-muted transition-colors hover:bg-bg-2 hover:text-text-primary';
  return (
    <div
      role="group"
      aria-label={`Options, ${at + 1} of ${item.choices.length}`}
      className="mr-auto inline-flex items-center gap-0.5"
    >
      <button
        type="button"
        aria-label="Previous option"
        onClick={() => onStep(-1)}
        data-dir="left"
        className={arrow}
      >
        <ChevronLeft className="size-4" strokeWidth={1.8} />
      </button>
      {item.choices.map((c, i) => (
        <button
          key={c.id}
          type="button"
          aria-label={`Option ${i + 1}: ${c.label}`}
          aria-current={i === at}
          title={c.label}
          onClick={() => onPick(c)}
          className="hf-dot grid size-[18px] place-items-center"
        />
      ))}
      <button
        type="button"
        aria-label="Next option"
        onClick={() => onStep(1)}
        data-dir="right"
        className={arrow}
      >
        <ChevronRight className="size-4" strokeWidth={1.8} />
      </button>
    </div>
  );
}

export type MenuKey = 'open' | 'brief' | 'another' | 'later' | 'ignore';
export type MenuItem = { key: MenuKey; label: string; hint: string };

const MENU_ICON: Record<MenuKey, typeof Play> = {
  open: PanelRightOpen,
  brief: FilePen,
  another: Shuffle,
  later: Clock,
  ignore: EyeOff,
};

export function menuItems(item: FeedItem, hasSession: boolean): MenuItem[] {
  const out: MenuItem[] = [];
  if (hasSession)
    out.push({ key: 'open', label: 'Open session', hint: 'See everything Claude did' });
  if (item.hasBrief)
    out.push({
      key: 'brief',
      label: 'Edit the brief first',
      hint: 'Change the goal and limits before starting',
    });
  out.push(
    item.group === 'needs_you'
      ? { key: 'later', label: 'Remind me in an hour', hint: 'Claude keeps waiting' }
      : { key: 'later', label: 'Not now', hint: 'Hide it until tomorrow' }
  );
  out.push({ key: 'ignore', label: 'Ignore', hint: 'Hide it; tell Rig why if you like' });
  return out;
}

/** The strong accent pill, joined like a drop to its round ▾ menu (the goo filter in `new-home.tsx`). */
function Action({
  verb,
  label,
  busy,
  onRun,
  menuOpen,
  setMenuOpen,
  items,
  onMenu,
}: {
  verb: FeedVerb;
  /** Says this instead of the verb (Retry, after a send that didn't go). */
  label?: string;
  /** Working on it: the button says this, spins, and can't be pressed again. */
  busy?: string;
  onRun: () => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  items: MenuItem[];
  onMenu: (key: MenuKey) => void;
}) {
  const Icon = label ? RotateCcw : VERB_ICON[verb];
  const wrapRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen, setMenuOpen]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setMenuOpen(false);
      caretRef.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

  const part =
    'hf-goo-part bg-accent text-accent-ink inline-flex h-9 items-center justify-center text-ui font-semibold';
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <div className="hf-goo inline-flex items-center gap-[3px]">
        <button
          type="button"
          onClick={onRun}
          disabled={!!busy}
          aria-busy={!!busy}
          data-motion="slide"
          style={{ '--hf-px': '15px' } as CSSProperties}
          className={cn(part, 'hf-btn hf-goo-main rounded-[18px] border-0', busy && 'cursor-progress')}
        >
          <span aria-hidden className="hf-btn-lead">
            {busy ? <Loader2 className="size-[15px] animate-spin" strokeWidth={2.4} /> : <Icon className="size-[15px]" strokeWidth={2.4} />}
          </span>
          <span>{busy ?? label ?? VERB_LABEL[verb]}</span>
          <span aria-hidden className="hf-btn-trail">
            <ArrowRight className="size-[15px]" strokeWidth={2.6} />
          </span>
        </button>
        <button
          ref={caretRef}
          type="button"
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
          className={cn(part, 'hf-goo-caret size-9 rounded-full')}
        >
          <span aria-hidden className="hf-chev" />
        </button>
      </div>
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKey}
          className="hf-menu-in absolute top-[calc(100%+8px)] right-0 z-30 grid w-[260px] gap-0.5 rounded-[12px] border border-border-hairline bg-bg-1 p-1.5 shadow-float"
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => onMenu(it.key)}
              className="group grid grid-cols-[18px_minmax(0,1fr)] gap-2 rounded-[8px] px-2.5 py-2 text-left outline-none hover:bg-bg-2 focus-visible:bg-bg-2"
            >
              <MenuIcon k={it.key} />
              <span>
                <b className="text-ui font-medium">{it.label}</b>
                <small className="mt-px block text-meta leading-[1.4] text-text-secondary">
                  {it.hint}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ignored ────────────────────────────────────────────────────────────────

/** An ignored item: one slim row, an optional why, and Undo. */
export function IgnoredRow({ entry }: { entry: FeedEntry }) {
  const { dispatch, toast, answerCard } = useHome();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const done = (why: string) => {
    answerCard(entry.item.id, 'ignore', { reason: why });
    dispatch({ type: 'remove', itemId: entry.item.id });
    toast(why ? `Thanks. Rig noted: “${why}”` : 'Ignored');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    done(inputRef.current?.value.trim() ?? '');
  };
  return (
    <div className="grid gap-2 border-b border-border-hairline bg-bg-2/40 px-5 pt-2.5 pb-3">
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <span className="min-w-0 truncate">
          Ignored <b className="font-medium text-text-secondary">{entry.item.title}</b>
        </span>
        <ActionButton
          variant="quiet"
          size="sm"
          icon={Undo2}
          motion="undo"
          onClick={() => dispatch({ type: 'ignore', itemId: entry.item.id, value: false })}
          className="-my-1 ml-auto h-6 text-accent hover:bg-accent-subtle hover:text-accent"
        >
          Undo
        </ActionButton>
      </div>
      <form onSubmit={submit} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-1.5">
        <input
          ref={inputRef}
          type="text"
          placeholder="Why? Optional, it helps Rig get this right"
          aria-label="Why you ignored it (optional)"
          className="min-w-0 rounded-[8px] border border-border-hairline bg-bg-1 px-[9px] py-[5px] text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
        />
        <ActionButton type="submit" variant="primary" size="sm" icon={Send} motion="send">
          Send
        </ActionButton>
        <ActionButton variant="quiet" size="sm" icon={X} motion="nudge" onClick={() => done('')}>
          Skip
        </ActionButton>
      </form>
    </div>
  );
}

function MenuIcon({ k }: { k: MenuKey }) {
  const Icon = MENU_ICON[k];
  return (
    <Icon
      aria-hidden
      className="mt-0.5 size-4 text-text-muted transition-colors group-hover:text-accent group-focus-visible:text-accent"
      strokeWidth={1.8}
    />
  );
}
