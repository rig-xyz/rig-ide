import { useQueryClient } from '@tanstack/react-query';
import { Hash, Link as LinkIcon, Loader2, Plus } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { MY_INVITES_KEY_PREFIX } from '@renderer/features/shell/invites-inbox';
import { rpc } from '@renderer/lib/ipc';
import { markJustAttachedSyncing } from '@renderer/lib/just-attached';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/lib/utils';
import { normalizeJoinLink } from './join-link';
import { generateSpaceName } from './space-create';

/**
 * Home's quick-create pill, floating above the Spaces card in the left
 * column (`home.tsx`). One click on "New space": `generateSpaceName` picks
 * a friendly, unique-among-your-spaces name and `onCreateSpace` (`home.tsx`'s
 * own `createSpace`) creates it and opens straight into its Room, no naming
 * dialog.
 *
 * Hovering (or focusing) it lets a round link bubble ooze out of its right
 * edge, in the same liquid language as the composer's `ContextPill`
 * (`features/spaces/components/context-pill.tsx`): the pill body and the
 * bubble are one liquid layer (an SVG goo filter over a single fill), so
 * at rest the bubble sits inside the pill's own fill; on hover the body
 * pulls back from its right end and the bubble pinches off there (inside
 * the column, so it never spills into the next one). Glow and edge are
 * separate layers, text crisp above. Hover is forgiving: open at once,
 * close after a short grace.
 *
 * Clicking the bubble stretches the whole pill into an inline field (the
 * link icon slides to the field's left edge, the accent fill turns into
 * the card surface): paste an invite link and it's accepted in the app,
 * then attached and opened, the same accept → `join.attach` → open path
 * the emailed-invite accept (`home.tsx`'s `PendingInviteInline`) takes.
 * Only without a usable sign-in does it fall back to the hub's own
 * `/join/<secret>` page in the browser. Escape, or leaving it empty,
 * collapses it back. Reduced motion: no ooze, just show/hide.
 */

const SPRING = 'cubic-bezier(.34,1.56,.64,1)';
const CLOSE_GRACE_MS = 280;
/** Bubble diameter and its inset from the pill's edge, in px (the pill is 40px tall). */
const BUBBLE = 32;
const INSET = 4;
/** How far the body pulls back from its right end while the bubble is out. */
const PULL_BACK = BUBBLE + INSET + 8;

export function NewSpaceCta({
  existingNames,
  onCreateSpace,
  onOpenPath,
}: {
  /** Every space name this account already has, for `generateSpaceName`'s collision check. */
  existingNames: ReadonlySet<string>;
  onCreateSpace: (name: string) => Promise<string | null>;
  /** Opens a joined space's local folder — Home's own `onOpenPath`. */
  onOpenPath: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion() ?? false;
  const filterId = `new-space-goo-${useId().replace(/:/g, '')}`;
  const createRef = useRef<HTMLButtonElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const refocusCreate = useRef(false);
  const leaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (leaveRef.current) clearTimeout(leaveRef.current);
    },
    []
  );

  const [out, setOut] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [value, setValue] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape hands focus back to "New space", once it's mounted again.
  useEffect(() => {
    if (!joinOpen && refocusCreate.current) {
      refocusCreate.current = false;
      createRef.current?.focus();
    }
  }, [joinOpen]);

  const enter = () => {
    if (leaveRef.current) clearTimeout(leaveRef.current);
    setOut(true);
  };
  const leave = () => {
    if (leaveRef.current) clearTimeout(leaveRef.current);
    leaveRef.current = setTimeout(() => setOut(false), CLOSE_GRACE_MS);
  };

  const createOneClick = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    const failure = await onCreateSpace(generateSpaceName(existingNames));
    setCreating(false);
    if (failure) setError(failure);
  };

  const openJoin = () => {
    setError(null);
    setOut(false);
    setJoinOpen(true);
  };
  const collapse = (refocus: boolean) => {
    refocusCreate.current = refocus;
    setJoinOpen(false);
    setValue('');
  };

  // A pasted link ends in its secret — and a focused text field scrolls to
  // the caret, i.e. to that secret. Put the caret (and the scroll) back at
  // the start so the field reads "https://userig.xyz/join/…"; the value
  // itself is untouched. (Once blurred, Chromium already scrolls a field
  // back to its start on its own.)
  const showLinkStart = () => {
    const input = linkInputRef.current;
    if (!input) return;
    if (document.activeElement === input) input.setSelectionRange(0, 0);
    input.scrollLeft = 0;
  };

  // The pasted link carries the invite's secret, so it's never echoed back in an error line.
  const submit = async () => {
    const url = normalizeJoinLink(value);
    if (!url) {
      setError("That doesn't look like a rig invite link.");
      return;
    }
    setJoining(true);
    setError(null);
    const joined = await rpc.rig.share.acceptInviteLink({ link: url });
    if (!joined.success) {
      if (joined.error.kind === 'notSignedIn') {
        // No usable sign-in on this device: the hub's own /join page can
        // sign in and accept there instead.
        const opened = await rpc.app.openExternal(url);
        setJoining(false);
        if (!opened.success) {
          setError(opened.error ?? "Couldn't open the browser.");
          return;
        }
        collapse(false);
        return;
      }
      setJoining(false);
      setError(joined.error.message);
      return;
    }

    void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
    void queryClient.invalidateQueries({ queryKey: MY_INVITES_KEY_PREFIX });
    const { bindingId, spaceName } = joined.data;
    const attached = await rpc.rig.join.attach({ bindingId, name: spaceName });
    setJoining(false);
    collapse(false);
    if (!attached.success) {
      // Joined server-side either way — the space shows on Home to set up from there.
      setError(`You joined ${spaceName ? `#${spaceName}` : 'the space'}, but it couldn't be set up here: ${attached.error.message}`);
      return;
    }
    markJustAttachedSyncing(attached.data.localPath, attached.data.syncing);
    onOpenPath(attached.data.localPath);
  };

  const bubbleOut = out && !joinOpen && !creating;
  const bodyWidth = bubbleOut ? `calc(100% - ${PULL_BACK}px)` : '100%';
  const bubbleLeft = joinOpen ? `${INSET}px` : `calc(100% - ${BUBBLE + INSET}px)`;
  const fill = joinOpen ? 'var(--bg-1)' : 'var(--accent)';
  /** Reduced motion: every layer just snaps to its state. */
  const ease = (transition: string) => (reduceMotion ? 'none' : transition);

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="relative h-10 w-full"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={enter}
        onBlur={leave}
        data-testid="new-space-cta"
        data-out={bubbleOut || undefined}
        data-join={joinOpen || undefined}
      >
        <svg width="0" height="0" className="absolute" aria-hidden>
          <defs>
            <filter id={filterId} x="-10%" y="-50%" width="120%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
              <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo" />
              <feBlend in="SourceGraphic" in2="goo" />
            </filter>
          </defs>
        </svg>
        {/* the field's float shadow (join only), under the liquid */}
        <span
          className={cn('shadow-float absolute inset-0 rounded-full', joinOpen ? 'opacity-100' : 'opacity-0')}
          style={{ transition: ease('opacity 250ms') }}
          aria-hidden
        />
        {/* one liquid fill: the body and the bubble */}
        <span
          className={cn('pointer-events-none absolute inset-0', creating && 'opacity-60')}
          style={{ filter: `url(#${filterId})` }}
          aria-hidden
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: bodyWidth,
              background: fill,
              transition: ease(`width 550ms ${SPRING}, background-color 250ms`),
            }}
          />
          <span
            className="absolute rounded-full"
            style={{
              top: INSET,
              left: bubbleLeft,
              width: BUBBLE,
              height: BUBBLE,
              background: fill,
              transform: `scale(${bubbleOut || joinOpen ? 1 : 0.6})`,
              transition: ease(`left 550ms ${SPRING}, transform 550ms ${SPRING} 40ms, background-color 250ms`),
            }}
          />
        </span>
        {/* the CTA's own top highlight + accent glow (idle only) */}
        <span
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 rounded-full',
            joinOpen ? 'opacity-0' : creating ? 'opacity-60' : 'opacity-100'
          )}
          style={{
            width: bodyWidth,
            boxShadow:
              'inset 0 1px 0 color-mix(in oklab, white 25%, transparent), 0 6px 18px color-mix(in oklab, var(--accent) 35%, transparent)',
            transition: ease(`width 550ms ${SPRING}, opacity 200ms`),
          }}
          aria-hidden
        />
        {/* the field's edge (join only) */}
        <span
          className={cn(
            'border-accent pointer-events-none absolute inset-0 rounded-full border',
            joinOpen ? 'opacity-100' : 'opacity-0'
          )}
          style={{ transition: ease('opacity 250ms') }}
          aria-hidden
        />
        {/* the link icon rides the bubble: at the right edge while it's out, then to the field's left edge */}
        <span
          className={cn(
            'pointer-events-none absolute z-10 flex items-center justify-center rounded-full',
            joinOpen ? 'text-text-muted' : 'text-accent-ink',
            bubbleOut || joinOpen ? 'opacity-100' : 'opacity-0'
          )}
          style={{
            top: INSET,
            left: bubbleLeft,
            width: BUBBLE,
            height: BUBBLE,
            // the bubble wears the body's own top highlight while it's out
            boxShadow: joinOpen ? 'none' : 'inset 0 1px 0 color-mix(in oklab, white 25%, transparent)',
            transition: ease(`left 550ms ${SPRING}, opacity 200ms${bubbleOut ? ' 100ms' : ''}`),
          }}
          aria-hidden
        >
          <LinkIcon className="size-4" strokeWidth={1.75} />
        </span>

        {joinOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="absolute inset-0 z-10 flex items-center gap-2 pr-1.5"
            style={{ paddingLeft: BUBBLE + INSET + 2 }}
          >
            <input
              ref={linkInputRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              // After the paste lands (its input event re-renders first).
              onPaste={() => requestAnimationFrame(showLinkStart)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !joining) {
                  e.preventDefault();
                  collapse(true);
                }
              }}
              onBlur={() => {
                if (!value.trim() && !joining) collapse(false);
              }}
              autoFocus
              placeholder="Paste an invite link"
              disabled={joining}
              aria-label="Invite link"
              className="text-text-primary placeholder:text-text-muted min-w-0 flex-1 bg-transparent text-sm outline-none disabled:cursor-not-allowed"
            />
            <Button type="submit" size="sm" className="rounded-full" disabled={joining || !value.trim()}>
              {joining && <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />}
              {joining ? 'Joining…' : 'Join'}
            </Button>
          </form>
        ) : (
          <>
            <button
              ref={createRef}
              type="button"
              onClick={() => void createOneClick()}
              disabled={creating}
              className="text-accent-ink focus-visible:outline-accent absolute inset-y-0 left-0 z-10 flex items-center gap-2 rounded-full px-4 text-sm font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-60"
              style={{ width: bodyWidth, transition: ease(`width 550ms ${SPRING}`) }}
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
              ) : (
                <Hash className="size-4" strokeWidth={1.5} />
              )}
              {creating ? 'Starting…' : 'New space'}
              {/* balances the "#": rides the body's right end as it pulls back for the bubble */}
              <Plus className="ml-auto size-4" strokeWidth={1.5} aria-hidden data-testid="new-space-plus" />
            </button>
            <button
              type="button"
              aria-label="Join with a link"
              title="Join with a link"
              onClick={openJoin}
              tabIndex={bubbleOut ? 0 : -1}
              className={cn(
                'focus-visible:outline-accent absolute z-10 rounded-full outline-none focus-visible:outline-2 focus-visible:outline-offset-2',
                bubbleOut ? 'pointer-events-auto' : 'pointer-events-none'
              )}
              style={{ top: INSET, left: bubbleLeft, width: BUBBLE, height: BUBBLE }}
            />
          </>
        )}
      </div>
      {error && (
        <p className="text-danger px-3 text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
