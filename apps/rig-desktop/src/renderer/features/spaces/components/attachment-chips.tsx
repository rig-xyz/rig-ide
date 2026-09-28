import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Popover } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import { formatAttachmentBytes } from '@shared/rig/attachments';
import {
  chipDetail,
  chipState,
  composerSummary,
  isLargeBatch,
  typeBadge,
  type ComposerAttachment,
} from '../attachments';
import type { ComposerAttachments } from '../use-composer-attachments';

/**
 * The composer's attachment chips (board 19, B): a preview or type badge,
 * the name (double-click to rename), size or the problem, and ✕. Amber is a
 * warning (sent, but only on your computer, or a secret you chose to share),
 * red holds Send. Many files fold into one summary chip. The footer counts
 * what's attached against the space's 50 MB.
 */

const BADGE_TONE: Record<string, string> = {
  image: 'bg-[#7fb3f0]',
  pdf: 'bg-[#e2726e]',
  doc: 'bg-[#62a4f5]',
  sheet: 'bg-[#5fbf8a]',
  slides: 'bg-[#e0a458]',
  video: 'bg-[#b48cf0]',
  audio: 'bg-[#b48cf0]',
  archive: 'bg-[#9aa4ae]',
  data: 'bg-[#9aa4ae]',
};

const previews = new Map<string, Promise<string | null>>();

function useSourcePreview(chip: ComposerAttachment): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = chip.verdict?.category === 'image';
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    let pending = previews.get(chip.source);
    if (!pending) {
      pending = rpc.rig.attachments.previewSource({ source: chip.source }).catch(() => null);
      previews.set(chip.source, pending);
    }
    void pending.then((value) => alive && setUrl(value));
    return () => {
      alive = false;
    };
  }, [chip.source, isImage]);
  return isImage ? url : null;
}

function Thumb({ chip }: { chip: ComposerAttachment }) {
  const preview = useSourcePreview(chip);
  const name = chip.verdict?.name ?? chip.source.split('/').pop() ?? '';
  if (preview) return <img src={preview} alt="" className="size-[26px] shrink-0 rounded-[6px] object-cover" />;
  return (
    <span
      className={cn(
        'flex size-[26px] shrink-0 items-center justify-center rounded-[6px] text-2xs font-bold text-[#0e1013]',
        BADGE_TONE[chip.verdict?.category ?? ''] ?? 'bg-[#9aa4ae]'
      )}
      aria-hidden
    >
      {typeBadge(name)}
    </span>
  );
}

function ShareAnyway({ chip, onConfirm }: { chip: ComposerAttachment; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);
  const message = chip.verdict?.problems.find((p) => p.kind === 'secret')?.message ?? '';
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen(true)}
        className="text-2xs text-text-muted underline decoration-dotted underline-offset-2 hover:text-text-primary"
      >
        Share anyway…
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} role="dialog" minWidth={260} ariaLabel="Share a secret-looking file">
        <div className="flex w-72 flex-col gap-2 p-3 text-xs text-text-secondary">
          <p>{message}</p>
          <p>
            Type <b className="font-medium text-text-primary">share</b> to send it anyway.
          </p>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed.trim().toLowerCase() === 'share') {
                onConfirm();
                setOpen(false);
              }
            }}
            className="border-border-hairline bg-bg-0 rounded-control border px-2 py-1 text-sm text-text-primary outline-none"
            aria-label="Type share to confirm"
          />
          <button
            type="button"
            disabled={typed.trim().toLowerCase() !== 'share'}
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
            className="bg-danger/15 self-end rounded-control px-2.5 py-1 text-danger disabled:opacity-50"
          >
            Share anyway
          </button>
        </div>
      </Popover>
    </>
  );
}

function Chip({ chip, attachments }: { chip: ComposerAttachment; attachments: ComposerAttachments }) {
  const [editing, setEditing] = useState(false);
  const state = chipState(chip);
  const name = chip.verdict?.storedName ?? chip.name ?? chip.source.split('/').pop() ?? '';
  const secret = chip.verdict?.problems.some((p) => p.kind === 'secret') && !chip.shareAnyway;
  const title = chip.error ?? chip.verdict?.problems.map((p) => p.message).join('\n') ?? undefined;
  return (
    <div
      className={cn(
        'bg-bg-2 flex h-[38px] max-w-[230px] items-center gap-2 rounded-[9px] border pr-1.5 pl-1.5 text-xs',
        state === 'warn' ? 'border-warning/50' : state === 'blocked' ? 'border-danger/40' : 'border-border-hairline'
      )}
      title={title || undefined}
      data-testid="attachment-chip"
      data-state={state}
    >
      <Thumb chip={chip} />
      <div className="flex min-w-0 flex-col leading-tight">
        {editing ? (
          <input
            autoFocus
            defaultValue={chip.verdict?.name ?? name}
            onBlur={(e) => {
              attachments.rename(chip.id, e.target.value);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="bg-bg-0 w-40 rounded px-1 text-xs text-text-primary outline-none"
            aria-label="File name"
          />
        ) : (
          <b
            className="truncate font-medium text-text-primary"
            onDoubleClick={() => chip.verdict?.disposition === 'copy' && setEditing(true)}
            title={chip.verdict?.disposition === 'copy' ? 'Double-click to rename' : undefined}
          >
            {name}
          </b>
        )}
        <span className={cn('truncate text-2xs', state === 'blocked' ? 'text-danger' : state === 'warn' ? 'text-warning' : 'text-text-muted')}>
          {chipDetail(chip)}
        </span>
        {secret && <ShareAnyway chip={chip} onConfirm={() => attachments.shareAnyway(chip.id)} />}
      </div>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={() => attachments.remove(chip.id)}
        className="hover:bg-bg-3 ml-auto flex size-5 shrink-0 items-center justify-center rounded text-text-muted"
      >
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function SummaryChip({ chips, onClear }: { chips: ComposerAttachment[]; onClear: () => void }) {
  const summary = composerSummary(chips);
  const names = chips.map((c) => c.verdict?.storedName ?? c.source.split('/').pop()).join('\n');
  return (
    <div
      className="bg-bg-2 border-border-hairline flex h-[38px] items-center gap-2 rounded-[9px] border px-2 text-xs"
      title={names}
      data-testid="attachment-summary-chip"
    >
      <b className="font-medium text-text-primary">{summary.label}</b>
      <button type="button" aria-label="Remove all files" onClick={onClear} className="flex size-5 items-center justify-center rounded text-text-muted">
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}

export function AttachmentChips({ attachments }: { attachments: ComposerAttachments }) {
  const { chips, space } = attachments;
  if (chips.length === 0) return null;
  const large = isLargeBatch(chips);
  // Folded into one chip, the ones with a problem still show on their own so they can be removed.
  const shown = large ? chips.filter((c) => chipState(c) === 'blocked' || chipState(c) === 'warn') : chips;
  const summary = composerSummary(chips);
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-2.5" data-testid="attachment-chips">
      <div className="flex flex-wrap gap-2">
        {large && <SummaryChip chips={chips} onClear={() => attachments.clear()} />}
        {shown.map((chip) => (
          <Chip key={chip.id} chip={chip} attachments={attachments} />
        ))}
      </div>
      <p className="text-2xs text-text-muted" data-testid="attachment-footer">
        {[summary.label, space?.usedBytes != null ? `space ${formatAttachmentBytes(space.usedBytes)} / ${formatAttachmentBytes(space.limitBytes)}` : '']
          .filter(Boolean)
          .join(' · ')}
        {attachments.holdReason && attachments.holdReason !== 'Checking the files…' && (
          <span className={cn(space?.overQuota || attachments.disabledReason ? 'text-danger' : 'text-text-muted')}>
            {` · ${attachments.holdReason}`}
          </span>
        )}
      </p>
    </div>
  );
}
