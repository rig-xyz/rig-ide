import { Check, Copy, FolderOpen, MoreHorizontal } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Popover, PopoverMenuItem } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/lib/utils';
import {
  formatAttachmentBytes,
  type AttachmentFileStatus,
  type AttachmentStatusQuery,
  type MessageAttachment,
} from '@shared/rig/attachments';
import { cardSettled, cardStatus, typeBadge, type CardStatus } from '../attachments';

/**
 * Files on a chat message (board 19, B): images as thumbnails made on this
 * computer from the space's copy, everything else as a card with its size
 * (and pages for a PDF). A click opens it beside the chat; ⋯ reveals it in
 * Finder or copies its path. Under each, where it is on its way to everyone:
 * yours "Syncing…" until the sync daemon has shipped it, others' "Arriving
 * from Sam…" until it's on this computer.
 */

export type AttachmentSpace = {
  bindingId: string;
  /** The space's folder on this computer (for Reveal / Copy path), when known. */
  spaceRoot: string | null;
  selfUserId: string;
  onOpenFile?: (relPath: string) => void;
  /** The IO, provided by the Room (`rig.attachments.status`/`thumbnail`, `app.*`), so rows stay free of the IPC bridge. */
  status: (files: AttachmentStatusQuery[], withRelay: boolean) => Promise<AttachmentFileStatus[] | null>;
  thumbnail: (path: string) => Promise<string | null>;
  reveal: (absPath: string) => void;
  copyText: (text: string) => void;
};

/** The space the transcript's cards belong to; null outside a live space (no cards' status then). */
export const AttachmentSpaceContext = createContext<AttachmentSpace | null>(null);

const POLL_MS = 3000;
/** Stop checking a message's files this long after it was sent (checked once when it's shown again). */
const POLL_WINDOW_MS = 30 * 60 * 1000;

function useFileStatuses(
  space: AttachmentSpace | null,
  attachments: readonly MessageAttachment[],
  opts: { mine: boolean; sending: boolean; createdAt: string; senderName: string }
): Map<string, AttachmentFileStatus> {
  const [statuses, setStatuses] = useState(new Map<string, AttachmentFileStatus>());
  const key = attachments.map((a) => `${a.path ?? ''}#${a.hash ?? ''}`).join('|');
  // Read inside the effect; `key` and the flags below are what restart it.
  const latest = useRef({ attachments, opts, space });
  latest.current = { attachments, opts, space };
  const bindingId = space?.bindingId ?? null;
  const { mine, sending } = opts;
  useEffect(() => {
    const { attachments, opts, space } = latest.current;
    if (!space || sending) return;
    const queries = attachments.filter((a) => a.path).map((a) => ({ path: a.path!, ...(a.hash ? { hash: a.hash } : {}) }));
    if (queries.length === 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      const result = await space.status(queries, !mine).catch(() => null);
      if (!alive || !result) return;
      const next = new Map(result.map((s) => [s.path, s]));
      setStatuses(next);
      const age = Date.now() - Date.parse(opts.createdAt);
      const settled = attachments.every((a) =>
        cardSettled(
          cardStatus({ attachment: a, mine, senderName: opts.senderName, status: a.path ? next.get(a.path) : undefined, messageAgeMs: age }),
          a,
          mine
        )
      );
      if (!settled && age < POLL_WINDOW_MS) timer = setTimeout(() => void check(), POLL_MS);
    };
    void check();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [bindingId, key, mine, sending]);
  return statuses;
}

const thumbs = new Map<string, Promise<string | null>>();

function useThumbnail(space: AttachmentSpace | null, attachment: MessageAttachment, present: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const path = attachment.path;
  useEffect(() => {
    if (!space || !path || !present || !attachment.mime.startsWith('image/')) return;
    const cacheKey = `${space.bindingId}:${path}:${attachment.hash ?? ''}`;
    let pending = thumbs.get(cacheKey);
    if (!pending) {
      pending = space.thumbnail(path).catch(() => null);
      thumbs.set(cacheKey, pending);
    }
    let alive = true;
    void pending.then((value) => {
      if (!alive) return;
      if (value === null) thumbs.delete(cacheKey);
      setUrl(value);
    });
    return () => {
      alive = false;
    };
  }, [space, path, present, attachment.mime, attachment.hash]);
  return url;
}

const TONE_TEXT: Record<CardStatus['tone'], string> = {
  ok: 'text-success',
  bad: 'text-danger',
  warn: 'text-warning',
  muted: 'text-text-muted',
};

/** The short status on a file card's second line; never cut (the size gives way first), the full sentence on hover. */
function StatusText({ status }: { status: CardStatus }) {
  return (
    <span className={cn('flex shrink-0 items-center gap-0.5 whitespace-nowrap', TONE_TEXT[status.tone])} title={status.label} data-testid="attachment-status">
      {status.tone === 'ok' && <Check className="size-3" strokeWidth={2} aria-hidden />}
      {status.short}
    </span>
  );
}

function CardMenu({ space, path, className }: { space: AttachmentSpace; path: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!space.spaceRoot) return null;
  const abs = `${space.spaceRoot.replace(/\/+$/, '')}/${path}`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label="More"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          'hover:bg-bg-3 flex size-6 shrink-0 items-center justify-center rounded text-text-muted opacity-0 transition-opacity group-hover/card:opacity-100 focus:opacity-100',
          className
        )}
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="right">
        <PopoverMenuItem
          label="Reveal in Finder"
          icon={FolderOpen}
          onSelect={() => {
            space.reveal(abs);
            setOpen(false);
          }}
        />
        <PopoverMenuItem
          label="Copy path"
          icon={Copy}
          onSelect={() => {
            space.copyText(abs);
            setOpen(false);
          }}
        />
      </Popover>
    </>
  );
}

/** An image: the thumbnail itself at its own shape, rounded like a bubble; name and status on hover, a dot while it travels. */
function ImageThumb({
  attachment,
  thumb,
  status,
  open,
  space,
}: {
  attachment: MessageAttachment;
  thumb: string;
  status: CardStatus | null;
  open: (() => void) | null;
  space: AttachmentSpace | null;
}) {
  const title = status ? `${attachment.name} · ${status.label}` : attachment.name;
  return (
    <div className="group/card relative" data-testid="attachment-card" data-kind="image">
      <button type="button" onClick={open ?? undefined} className="block overflow-hidden rounded-2xl" title={title}>
        <img src={thumb} alt={attachment.name} className="block h-auto max-h-[200px] w-auto max-w-[240px]" />
      </button>
      {status && (status.pending || status.tone === 'bad') && (
        <span
          className={cn(
            'ring-bg-0 absolute right-1.5 bottom-1.5 size-2 rounded-full ring-2',
            status.tone === 'bad' ? 'bg-danger' : 'bg-text-muted animate-pulse'
          )}
          title={status.label}
          data-testid="attachment-status-dot"
        />
      )}
      {space && attachment.path && (
        <CardMenu space={space} path={attachment.path} className="bg-bg-1/80 absolute top-1 right-1" />
      )}
    </div>
  );
}

/** Any other file: a compact card like the composer's chip — badge, name, then size · status. */
function FileCard({
  attachment,
  status,
  open,
  space,
}: {
  attachment: MessageAttachment;
  status: CardStatus | null;
  open: (() => void) | null;
  space: AttachmentSpace | null;
}) {
  const detail = [
    attachment.size ? formatAttachmentBytes(attachment.size) : '',
    attachment.pages ? `${attachment.pages} ${attachment.pages === 1 ? 'page' : 'pages'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className={cn(
        'group/card bg-bg-2 border-border-hairline flex h-[52px] w-[260px] max-w-full items-center gap-2.5 rounded-xl border px-2.5',
        open && 'hover:border-border-strong cursor-pointer'
      )}
      onClick={open ?? undefined}
      role={open ? 'button' : undefined}
      tabIndex={open ? 0 : undefined}
      onKeyDown={(e) => {
        if (open && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          open();
        }
      }}
      title={status ? `${attachment.name} · ${status.label}` : attachment.name}
      data-testid="attachment-card"
      data-kind={attachment.kind}
    >
      <span className="bg-bg-3 flex size-8 shrink-0 items-center justify-center rounded-lg text-2xs font-bold text-text-secondary">
        {typeBadge(attachment.name)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <b className="truncate text-xs font-medium text-text-primary">{attachment.name}</b>
        <span className="flex min-w-0 items-center gap-1 text-2xs text-text-muted">
          {detail && <span className="min-w-0 truncate">{detail}</span>}
          {detail && status && <span aria-hidden>·</span>}
          {status && <StatusText status={status} />}
        </span>
      </div>
      {space && attachment.path && <CardMenu space={space} path={attachment.path} />}
    </div>
  );
}

function AttachmentItem({
  attachment,
  status,
  fileStatus,
  space,
}: {
  attachment: MessageAttachment;
  status: CardStatus | null;
  fileStatus: AttachmentFileStatus | undefined;
  space: AttachmentSpace | null;
}) {
  const present = !!fileStatus?.exists;
  const thumb = useThumbnail(space, attachment, present);
  const openable = present && !!attachment.path && !!space?.onOpenFile;
  const open = openable ? () => space!.onOpenFile!(attachment.path!) : null;
  // No thumbnail yet (still arriving, or not an image we can preview): the compact card, never an empty square.
  return thumb ? (
    <ImageThumb attachment={attachment} thumb={thumb} status={status} open={open} space={space} />
  ) : (
    <FileCard attachment={attachment} status={status} open={open} space={space} />
  );
}

export function MessageAttachments({
  attachments,
  mine,
  sending = false,
  createdAt,
  senderName,
}: {
  attachments: MessageAttachment[];
  mine: boolean;
  sending?: boolean;
  createdAt: string;
  senderName: string;
}) {
  const space = useContext(AttachmentSpaceContext);
  const statuses = useFileStatuses(space, attachments, { mine, sending, createdAt, senderName });
  const age = Date.now() - Date.parse(createdAt);
  const items = attachments.map((attachment, i) => {
    const fileStatus = attachment.path ? statuses.get(attachment.path) : undefined;
    return {
      key: `${attachment.path ?? attachment.name}-${i}`,
      attachment,
      fileStatus,
      status: cardStatus({ attachment, mine, senderName, status: fileStatus, sending, messageAgeMs: age }),
    };
  });
  // Images wrap in a row; other files stack, each on its own line.
  const images = items.filter((item) => item.attachment.mime.startsWith('image/'));
  const files = items.filter((item) => !item.attachment.mime.startsWith('image/'));
  const render = (item: (typeof items)[number]) => (
    <AttachmentItem key={item.key} attachment={item.attachment} status={item.status} fileStatus={item.fileStatus} space={space} />
  );
  return (
    <div className={cn('flex max-w-full flex-col gap-1', mine ? 'items-end' : 'items-start')} data-testid="message-attachments">
      {images.length > 0 && <div className={cn('flex max-w-full flex-wrap gap-1', mine && 'justify-end')}>{images.map(render)}</div>}
      {files.map(render)}
    </div>
  );
}
