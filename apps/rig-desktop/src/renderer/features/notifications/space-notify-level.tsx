import { useQueryClient } from '@tanstack/react-query';
import { Bell, BellDot, BellOff, Check } from 'lucide-react';
import { useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Popover } from '@renderer/lib/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { levelLabel, NOTIFICATION_LEVELS, type NotificationLevel } from '@shared/rig/notifications';
import { NOTIFICATION_SUMMARY_KEY, useSpaceNotifications } from './use-notifications';

/**
 * The per-space notification level control (`rig/docs/notifications-spec.md`
 * §5): Slack-style All/Mentions/Nothing, settable from the space header's
 * bell (`SpaceNotifyLevelButton`) and the space card's Details row
 * (`SpaceNotifyLevelRow`). Both read `useSpaceNotifications` — main holds
 * the relay's summary — and write through `rpc.rig.notifications.setLevel`,
 * which lives on the relay rather than local settings: it decides which
 * rows get written, and Slack or email will need it later too.
 */

// The same words as Settings › Notifications' "Show banners for" (`levelLabel`).
const LEVEL_LABEL: Record<NotificationLevel, string> = {
  all: levelLabel('all'),
  mentions: levelLabel('mentions'),
  nothing: levelLabel('nothing'),
};

const LEVEL_DESCRIPTION: Record<NotificationLevel, string> = {
  all: 'Every message and comment in this space',
  mentions: 'Mentions, replies, your agents and invites',
  nothing: 'No banners. Mentions still show in Activity',
};

function LevelIcon({ level, className }: { level: NotificationLevel; className?: string }) {
  if (level === 'nothing') return <BellOff className={className} strokeWidth={1.5} />;
  if (level === 'mentions') return <BellDot className={className} strokeWidth={1.5} />;
  return <Bell className={className} strokeWidth={1.5} />;
}

/** Shared level read + write, so the header bell and the card row stay in lockstep. */
function useLevelControl(bindingId: string) {
  const queryClient = useQueryClient();
  const { level } = useSpaceNotifications(bindingId);

  const setLevel = async (next: NotificationLevel) => {
    const result = await rpc.rig.notifications.setLevel({ bindingId, level: next });
    if (result.success) void queryClient.invalidateQueries({ queryKey: NOTIFICATION_SUMMARY_KEY });
  };

  return { level, setLevel };
}

function LevelMenu({
  anchor,
  open,
  onClose,
  level,
  onSelect,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  level: NotificationLevel;
  onSelect: (next: NotificationLevel) => void;
}) {
  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      role="menu"
      align="right"
      estimatedWidth={260}
      minWidth={260}
      ariaLabel="Notifications"
    >
      <div className="flex flex-col gap-0.5 p-1">
        {NOTIFICATION_LEVELS.map((candidate) => {
          const selected = candidate === level;
          return (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={selected}
              onClick={() => {
                onSelect(candidate);
                onClose();
              }}
              className="flex w-full items-start gap-2 rounded-control px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-bg-2 focus-visible:bg-bg-2"
            >
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm', selected ? 'text-text-primary' : 'text-text-secondary')}>
                  {LEVEL_LABEL[candidate]}
                </p>
                <p className="text-text-muted text-xs">{LEVEL_DESCRIPTION[candidate]}</p>
              </div>
              {selected && <Check className="mt-0.5 size-3.5 shrink-0 text-text-primary" strokeWidth={1.5} />}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

/** The space header's bell — same 28px icon-button shape as the topbar's other controls (`invites-bell.tsx`). */
export function SpaceNotifyLevelButton({ bindingId }: { bindingId: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { level, setLevel } = useLevelControl(bindingId);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={`Notifications: ${LEVEL_LABEL[level]}`}
              aria-haspopup="true"
              aria-expanded={open}
              className="text-text-muted hover:bg-bg-2 rounded-control flex size-7 items-center justify-center transition-colors [-webkit-app-region:no-drag]"
            >
              <LevelIcon level={level} className="size-3.5" />
            </button>
          }
        />
        <TooltipContent side="bottom">Notifications: {LEVEL_LABEL[level]}</TooltipContent>
      </Tooltip>
      <LevelMenu
        anchor={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        level={level}
        onSelect={(next) => void setLevel(next)}
      />
    </>
  );
}

/** The space card's "Notifications" row — the same icon · label ···· value grammar as `space-card.tsx`'s other rows, opening the same menu. */
export function SpaceNotifyLevelRow({ bindingId }: { bindingId: string }) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const { level, setLevel } = useLevelControl(bindingId);

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className="hover:bg-bg-2 flex h-7 w-full items-center gap-2 rounded-control px-2 text-left transition-colors"
      >
        <LevelIcon level={level} className="size-3.5 shrink-0 text-text-muted" />
        <span className="text-xs text-text-primary">Notifications</span>
        <span className="ml-auto shrink-0 text-xs text-text-muted">{LEVEL_LABEL[level]}</span>
      </button>
      <LevelMenu
        anchor={rowRef}
        open={open}
        onClose={() => setOpen(false)}
        level={level}
        onSelect={(next) => void setLevel(next)}
      />
    </>
  );
}
