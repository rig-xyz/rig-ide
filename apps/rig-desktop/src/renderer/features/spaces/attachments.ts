import {
  formatAttachmentBytes,
  parseMessageAttachments,
  safeMessagePath,
  type AttachmentCommitted,
  type AttachmentFileStatus,
  type AttachmentVerdict,
  type MessageAttachment,
} from '@shared/rig/attachments';

export { parseMessageAttachments, safeMessagePath };

/**
 * Chat attachments in the Room (board 19): what a message carries in
 * `meta.attachments`, and what each card and chip says. Pure; the
 * components and `room-view.tsx` do the IO.
 */

/** A file waiting in the composer. `verdict` arrives from main's `prepare`. */
export type ComposerAttachment = {
  id: string;
  source: string;
  /** Known the moment it's added (the dropped file, or a quick look at the picked one), before main's checks. */
  size?: number;
  /** What the user typed on the chip, if they renamed it. */
  name?: string;
  shareAnyway?: boolean;
  verdict?: AttachmentVerdict;
  /** Why the last send didn't go (the copy failed). */
  error?: string;
};

/** More than this many files, or this many bytes, show as one summary chip and ask before sending. */
export const SUMMARY_FILES = 20;
export const SUMMARY_BYTES = 40 * 1024 * 1024;

const ARRIVING_GRACE_MS = 10 * 60 * 1000;

/**
 * The message's attachments from what `commit` did. Never an absolute path:
 * a local-only file is named only (its path may be outside the space).
 */
export function toMessageAttachments(
  committed: readonly AttachmentCommitted[],
  verdicts: ReadonlyMap<string, AttachmentVerdict | undefined> = new Map()
): MessageAttachment[] {
  return committed.map((file) => {
    const pages = verdicts.get(file.source)?.pageCount;
    const local = file.kind === 'local-only';
    const path = local ? undefined : safeMessagePath(file.path);
    return {
      name: file.name,
      size: file.size,
      mime: file.mime,
      kind: file.kind,
      ...(path ? { path } : {}),
      ...(!local && file.hash ? { hash: file.hash } : {}),
      ...(pages ? { pages } : {}),
    };
  });
}

/** The message text when only files are sent (the relay needs a body; older apps show it). */
export function fallbackBody(attachments: readonly MessageAttachment[]): string {
  return attachments.length === 1 ? `Shared ${attachments[0]!.name}` : `Shared ${attachments.length} files`;
}

/**
 * `label` is the full sentence (the tooltip); `short` is what fits on the
 * card's one line without ever being cut ("syncing", "synced"…); `pending`
 * marks a journey still under way (a small dot on an image).
 */
export type CardStatus = { label: string; short: string; tone: 'muted' | 'ok' | 'warn' | 'bad'; pending?: boolean };

/** What a card says under the file: its journey to everyone, or null when there's nothing to say. */
export function cardStatus(args: {
  attachment: MessageAttachment;
  mine: boolean;
  /** The sender's name, for other people's cards. */
  senderName: string;
  status: AttachmentFileStatus | undefined;
  sending?: boolean;
  messageAgeMs: number;
}): CardStatus | null {
  const { attachment, mine, senderName, status } = args;
  if (attachment.kind === 'local-only') {
    const label = mine ? 'Only on your computer' : `Only on ${senderName}’s computer`;
    return { label, short: label.charAt(0).toLowerCase() + label.slice(1), tone: 'muted' };
  }
  if (args.sending) return null;
  if (!attachment.path || !status) return null;
  const removed: CardStatus = { label: 'Removed from the space', short: 'removed', tone: 'bad' };
  if (mine) {
    if (!status.exists) return removed;
    if (status.notSynced === 'overQuota') return { label: 'Not synced: over the space’s 50 MB', short: 'not synced · space full', tone: 'bad' };
    if (status.notSynced === 'tooLarge') return { label: 'Not synced: too large', short: 'not synced · too large', tone: 'bad' };
    if (status.synced === null) return { label: 'Added', short: 'added', tone: 'muted' };
    return status.synced
      ? { label: 'Synced', short: 'synced', tone: 'ok' }
      : { label: 'Syncing…', short: 'syncing', tone: 'muted', pending: true };
  }
  if (status.exists) return null;
  if (status.deletedOnRelay) return removed;
  // Never on the relay: the sender's computer hasn't shared it (its sync may
  // be off). Not "removed": nobody deleted anything, and it can still arrive.
  if (status.onRelay === false && args.messageAgeMs > ARRIVING_GRACE_MS) {
    return { label: `${senderName}’s computer hasn’t shared it yet`, short: 'not shared yet', tone: 'warn', pending: true };
  }
  return { label: `Arriving from ${senderName}…`, short: 'arriving', tone: 'muted', pending: true };
}

/** Whether a card's status can still change on its own (worth checking again). */
export function cardSettled(status: CardStatus | null, attachment: MessageAttachment, mine: boolean): boolean {
  if (attachment.kind === 'local-only' || !attachment.path) return true;
  if (!status) return !mine;
  return status.label === 'Synced' || status.label === 'Added' || status.tone === 'bad';
}

/** "3 files · 6.3 MB", counting what would actually be sent. */
export function composerSummary(chips: readonly ComposerAttachment[]): { count: number; bytes: number; label: string } {
  const bytes = chips.reduce((sum, chip) => sum + (chipSize(chip) ?? 0), 0);
  const count = chips.length;
  return { count, bytes, label: `${count} ${count === 1 ? 'file' : 'files'} · ${formatAttachmentBytes(bytes)}` };
}

/** Whether these chips are many enough to show as one summary chip and ask before sending. */
export function isLargeBatch(chips: readonly ComposerAttachment[]): boolean {
  const { count, bytes } = composerSummary(chips);
  return count > SUMMARY_FILES || bytes >= SUMMARY_BYTES;
}

/** A chip's state, `pending` until main has checked it. */
export function chipState(chip: ComposerAttachment): 'pending' | 'ok' | 'warn' | 'blocked' {
  if (chip.error) return 'blocked';
  return chip.verdict ? chip.verdict.state : 'pending';
}

/** The chip's size: main's answer once it's in, else what was known when it was added. */
export function chipSize(chip: ComposerAttachment): number | null {
  return chip.verdict?.size ?? chip.size ?? null;
}

/** What a chip's second line says: size (and pages), or its problem. Never a "checking" label. */
export function chipDetail(chip: ComposerAttachment): string {
  if (chip.error) return chip.error;
  const v = chip.verdict;
  const bytes = chipSize(chip);
  const size = bytes !== null ? formatAttachmentBytes(bytes) : '';
  if (!v) return size;
  const problem = v.problems.find((p) => p.kind !== 'secret' || !chip.shareAnyway);
  if (problem?.kind === 'tooLarge') return `${size} · over 25 MB`;
  if (problem?.kind === 'secret') return 'Looks like a secret';
  if (problem?.kind === 'localOnly') return `${size} · only on your computer`;
  if (problem) return problem.message;
  const extra = v.pageCount ? `${v.pageCount} ${v.pageCount === 1 ? 'page' : 'pages'}` : v.disposition === 'link' ? 'in the space' : '';
  return [size, extra].filter(Boolean).join(' · ');
}

/** A short badge for a file type ("PDF", "PNG", "MP4"). */
export function typeBadge(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  return ext ? ext.toUpperCase().slice(0, 4) : 'FILE';
}
