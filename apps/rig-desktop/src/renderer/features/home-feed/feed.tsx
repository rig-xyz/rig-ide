import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  FilePen,
  Inbox,
  PanelRightOpen,
  Play,
  Plus,
  Reply,
  Send,
  Undo2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { DotMatrix } from '@renderer/lib/ui/dot-matrix';
import { cn } from '@renderer/lib/utils';
import { ActionButton } from './action-button';
import { Face, Kicker, SessionMatrix, SourceLogo, sourceName } from './bits';
import { rectOf, useHome } from './home-context';
import { PEOPLE } from './mock';
import type { FeedChoice, FeedItem, FeedVerb } from './model';
import {
  chosen,
  normalizeText,
  parseSay,
  sayParts,
  sayPlain,
  spaceLabel,
  stepChoice,
  VERB_LABEL,
} from './say';
import { type FeedEntry, findSession } from './store';

/**
 * Right: the Feed, what needs to happen next, action first. Two groups, Needs
 * you and Up next; every item is a full-width row whose button names the one
 * thing that will happen (Reply, Start session, Create space, Open). Acting
 * on one moves it into the rail.
 */

export function Feed({ headerEnd }: { headerEnd?: ReactNode }) {
  const { state, counts, toast } = useHome();
  const needs = state.feed.filter((e) => e.item.group === 'needs_you');
  const next = state.feed.filter((e) => e.item.group === 'up_next');
  return (
    <aside
      aria-label="Feed"
      className="flex min-h-0 min-w-0 flex-col border-l border-border-hairline bg-bg-1"
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 pr-3 pl-5 [-webkit-app-region:drag]">
        <h2 className="m-0 font-display text-title font-medium">Feed</h2>
        <span className="ml-auto text-meta text-text-muted">
          {counts.needsYou} {counts.needsYou === 1 ? 'needs' : 'need'} you · {counts.upNext} up next
        </span>
        {headerEnd && (
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">{headerEnd}</div>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-5">
        <Group title="Needs you" tone="warn" entries={needs} />
        <Group title="Up next" tone="accent" entries={next} />
        {!needs.length && !next.length && (
          <p className="px-5 py-2.5 text-sm text-text-muted">Nothing waiting on you.</p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2.5 border-t border-border-hairline px-5 py-2.5 text-meta text-text-muted">
        <span>3 topics held back</span>
        <ActionButton
          variant="quiet"
          size="sm"
          icon={Inbox}
          className="-my-1 -mr-2.5 text-accent hover:text-accent"
          onClick={() => toast("The Inbox isn't in this preview yet")}
        >
          See in Inbox
        </ActionButton>
      </div>
    </aside>
  );
}

function Group({
  title,
  tone,
  entries,
}: {
  title: string;
  tone: 'warn' | 'accent';
  entries: FeedEntry[];
}) {
  const { reducedMotion } = useHome();
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {entries.length > 0 && (
        <motion.div
          key={`head-${title}`}
          layout={!reducedMotion}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.2 }}
          className="px-5 pt-3.5 pb-1.5"
        >
          <Kicker className="flex items-center gap-2">
            <span aria-hidden className="hf-group-dot" data-tone={tone} />
            {title}
          </Kicker>
        </motion.div>
      )}
      {entries.map((entry) => (
        <motion.div
          key={entry.item.id}
          layout={!reducedMotion}
          exit={{ opacity: 0, x: 16, scale: 0.98 }}
          transition={{ duration: reducedMotion ? 0 : 0.3, ease: [0.2, 0.8, 0.2, 1] }}
          className="relative"
        >
          {entry.ignored ? <IgnoredRow entry={entry} /> : <FeedRow entry={entry} />}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

const VERB_ICON: Record<FeedVerb, typeof Play> = {
  reply: Reply,
  start: Play,
  space: Plus,
  open: Eye,
};

function FeedRow({ entry }: { entry: FeedEntry }) {
  const { spaces, dispatch, runItem, open } = useHome();
  const { item } = entry;
  const choice = chosen(item, entry.pick);
  const articleRef = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const session = item.sessionId ? findSession(spaces, item.sessionId)?.session : undefined;
  const needs = item.group === 'needs_you';

  const run = () => runItem(item.id, rectOf(articleRef.current));
  const pick = (to: FeedChoice) => {
    if (to.id === choice.id) return;
    const from = item.choices.indexOf(choice);
    dispatch({
      type: 'pick',
      itemId: item.id,
      choiceId: to.id,
      slide: item.choices.indexOf(to) < from ? 'right' : 'left',
    });
  };
  const step = (by: number) => {
    const to = stepChoice(item, entry.pick, by);
    dispatch({ type: 'pick', itemId: item.id, choiceId: to.id, slide: by < 0 ? 'right' : 'left' });
  };

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
            {session ? (
              <SessionMatrix session={session} />
            ) : (
              <DotMatrix state="quiet" tone="mute" />
            )}
          </span>
          <span className="truncate text-meta text-text-muted">
            {spaceLabel(item, choice, spaces)}
          </span>
          <Stack item={item} />
        </div>
        <button
          type="button"
          onClick={() =>
            session
              ? open({ kind: 'session', id: session.id })
              : open({ kind: 'brief', itemId: item.id })
          }
          className="ml-7 text-left text-base leading-[1.3] font-semibold text-text-primary decoration-border-strong underline-offset-[3px] hover:underline"
        >
          {item.title}
        </button>
        <Say entry={entry} choice={choice} onRun={run} />
        {entry.edited !== null && (
          <div className="flex items-center pl-7 text-xs text-text-muted">
            <span className="mr-1">Edited</span>
            <ActionButton
              variant="quiet"
              size="sm"
              icon={Undo2}
              motion="undo"
              onClick={() => dispatch({ type: 'reset', itemId: item.id })}
              className="h-6 text-accent hover:bg-accent-subtle hover:text-accent"
            >
              Undo
            </ActionButton>
          </div>
        )}
        <div className="mt-1.5 flex items-center justify-end gap-2.5 pl-7">
          <Carousel item={item} choice={choice} onPick={pick} onStep={step} />
          <Action
            verb={choice.verb}
            onRun={run}
            menuOpen={menuOpen}
            setMenuOpen={setMenuOpen}
            items={menuItems(item, !!session)}
            onMenu={(key) => {
              setMenuOpen(false);
              if (key === 'open' && session) open({ kind: 'session', id: session.id });
              else if (key === 'brief') open({ kind: 'brief', itemId: item.id });
              else if (key === 'later') {
                dispatch({ type: 'remove', itemId: item.id });
                dispatch({
                  type: 'toast',
                  text: needs ? 'Reminder set for an hour' : 'Hidden until tomorrow',
                });
              } else if (key === 'ignore')
                dispatch({ type: 'ignore', itemId: item.id, value: true });
            }}
          />
        </div>
      </article>
    </div>
  );
}

/** The source's logo, then the people involved, overlapping. */
function Stack({ item }: { item: FeedItem }) {
  const people = item.people.map((id) => PEOPLE[id]).filter((p): p is NonNullable<typeof p> => !!p);
  if (!item.source && !people.length) return <span />;
  return (
    <span className="hf-stack inline-flex items-center">
      {item.source && (
        <span
          title={`From ${sourceName(item.source.connector)} · ${item.source.scope} · ${item.source.ref}`}
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
}: {
  entry: FeedEntry;
  choice: FeedChoice;
  onRun: () => void;
}) {
  const { dispatch } = useHome();
  const { item } = entry;
  const handlers = useRef<SayHandlers>({ onInput: () => {}, onRun });
  handlers.current = {
    onRun,
    onInput: (text) => {
      const original = normalizeText(sayPlain(item, choice));
      const next = normalizeText(text);
      dispatch({ type: 'edit', itemId: item.id, text: next === original ? null : next });
    },
  };
  return (
    <div data-edited={entry.edited !== null} className="hf-say-wrap mt-1.5 ml-5">
      <EditableSay
        renderKey={`${choice.id}:${entry.resetKey}`}
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

type MenuKey = 'open' | 'brief' | 'later' | 'ignore';

const MENU_ICON: Record<MenuKey, typeof Play> = {
  open: PanelRightOpen,
  brief: FilePen,
  later: Clock,
  ignore: EyeOff,
};

function menuItems(
  item: FeedItem,
  hasSession: boolean
): Array<{ key: MenuKey; label: string; hint: string }> {
  const out: Array<{ key: MenuKey; label: string; hint: string }> = [];
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
  onRun,
  menuOpen,
  setMenuOpen,
  items,
  onMenu,
}: {
  verb: FeedVerb;
  onRun: () => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  items: Array<{ key: MenuKey; label: string; hint: string }>;
  onMenu: (key: MenuKey) => void;
}) {
  const Icon = VERB_ICON[verb];
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
          data-motion="slide"
          style={{ '--hf-px': '15px' } as CSSProperties}
          className={cn(part, 'hf-btn hf-goo-main rounded-[18px] border-0')}
        >
          <span aria-hidden className="hf-btn-lead">
            <Icon className="size-[15px]" strokeWidth={2.4} />
          </span>
          <span>{VERB_LABEL[verb]}</span>
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
function IgnoredRow({ entry }: { entry: FeedEntry }) {
  const { dispatch } = useHome();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const done = (why: string) => {
    dispatch({ type: 'remove', itemId: entry.item.id });
    dispatch({ type: 'toast', text: why ? `Thanks. Rig noted: “${why}”` : 'Ignored' });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    done(inputRef.current?.value.trim() ?? '');
  };
  return (
    <div className="grid gap-2 border-b border-border-hairline bg-bg-0 px-5 pt-2.5 pb-3">
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
