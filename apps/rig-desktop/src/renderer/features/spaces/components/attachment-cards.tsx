import { Copy, FolderOpen, MoreHorizontal } from 'lucide-react';
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

function StatusLine({ status }: { status: CardStatus | null }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        'truncate text-2xs',
        status.tone === 'ok' ? 'text-success' : status.tone === 'bad' ? 'text-danger' : status.tone === 'warn' ? 'text-warning' : 'text-text-muted'
      )}
      data-testid="attachment-status"
    >
      {status.tone === 'ok' ? `✓ ${status.label.toLowerCase()}` : status.label}
    </span>
  );
}

function CardMenu({ space, path }: { space: AttachmentSpace; path: string }) {
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
        className="hover:bg-bg-3 flex size-6 shrink-0 items-center justify-center rounded text-text-muted opacity-0 transition-opacity group-hover/card:opacity-100 focus:opacity-100"
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

function AttachmentCard({
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
  const open = () => openable && space!.onOpenFile!(attachment.path!);
  const detail = [
    attachment.pages ? `${attachment.pages} ${attachment.pages === 1 ? 'page' : 'pages'}` : '',
    attachment.size ? formatAttachmentBytes(attachment.size) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (thumb) {
    return (
      <div className="group/card relative flex max-w-[260px] flex-col gap-1" data-testid="attachment-card" data-kind="image">
        <button type="button" onClick={open} className="overflow-hidden rounded-[10px] border border-border-hairline" title={attachment.name}>
          <img src={thumb} alt={attachment.name} className="max-h-48 max-w-[260px] object-cover" />
        </button>
        <div className="flex items-center gap-1.5 px-0.5">
          <span className="min-w-0 truncate text-2xs text-text-muted">{attachment.name}</span>
          <StatusLine status={status} />
          {space && attachment.path && <CardMenu space={space} path={attachment.path} />}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        'group/card bg-bg-2 border-border-hairline flex w-[260px] items-center gap-2.5 rounded-[10px] border px-2.5 py-2',
        openable && 'hover:border-border-strong cursor-pointer'
      )}
      onClick={open}
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      onKeyDown={(e) => {
        if (openable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          open();
        }
      }}
      title={attachment.name}
      data-testid="attachment-card"
      data-kind={attachment.kind}
    >
      <span className="bg-bg-3 flex size-[34px] shrink-0 items-center justify-center rounded-[7px] text-2xs font-bold text-text-secondary">
        {typeBadge(attachment.name)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <b className="truncate text-xs font-medium text-text-primary">{attachment.name}</b>
        {detail && <span className="truncate text-2xs text-text-muted">{detail}</span>}
        <StatusLine status={status} />
      </div>
      {space && attachment.path && <CardMenu space={space} path={attachment.path} />}
    </div>
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
  return (
    <div className={cn('flex flex-wrap gap-2', mine && 'justify-end')} data-testid="message-attachments">
      {attachments.map((attachment, i) => {
        const fileStatus = attachment.path ? statuses.get(attachment.path) : undefined;
        const status = cardStatus({ attachment, mine, senderName, status: fileStatus, sending, messageAgeMs: age });
        return (
          <AttachmentCard
            key={`${attachment.path ?? attachment.name}-${i}`}
            attachment={attachment}
            status={status}
            fileStatus={fileStatus}
            space={space}
          />
        );
      })}
    </div>
  );
}
