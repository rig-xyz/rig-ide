/**
 * Chat file attachments (board 19, "File uploads"): the contract between the
 * main-process attachments service (`main/rig/attachments/`) and the
 * composer/transcript in the renderer.
 *
 * A space is a synced folder, so an attachment is a file in that folder:
 * copied on SEND into one flat `attachments/` folder at the space root, or
 * linked when it's already in the space. `prepare` answers what each chip
 * should say before anything is copied; `commit` does the copy at send time.
 */

/** Attachments can be up to 25 MB each, so one file can't take half of a 50 MB space. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** The space quota the relay enforces (current files only). */
export const SPACE_QUOTA_BYTES = 50 * 1024 * 1024;
/** Images up to this size also go to agents as image content. */
export const ATTACHMENT_IMAGE_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
/** The folder at the space root that attachments are copied into. */
export const ATTACHMENTS_DIR = 'attachments';

export type AttachmentCategory =
  | 'image'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'text'
  | 'video'
  | 'audio'
  | 'archive'
  | 'data'
  | 'other';

/**
 * What `commit` will do with the file:
 * - `copy`: copied into `attachments/` under `name`
 * - `reuse`: the same content is already in `attachments/` (`linkPath`), linked again
 * - `link`: already in the space (`linkPath`), linked, never copied
 * - `localOnly`: sync would never ship it (a database, `.env`…); not copied, only your own agent can read it
 */
export type AttachmentDisposition = 'copy' | 'reuse' | 'link' | 'localOnly';

export type AttachmentProblemKind =
  /** Over 25 MB. Blocked. */
  | 'tooLarge'
  /** Looks like a secret. Blocked unless the user typed "Share anyway". */
  | 'secret'
  /** Stays on this computer (see `localOnly` above). A warning, not a block. */
  | 'localOnly'
  /** A folder, or a link to one. Blocked in v1. */
  | 'folder'
  /** Not there anymore. Blocked. */
  | 'missing'
  /** Can't be read (permissions). Blocked. */
  | 'unreadable';

export type AttachmentProblem = { kind: AttachmentProblemKind; message: string };

export type AttachmentChipState = 'ok' | 'warn' | 'blocked';

/** One file to attach, as the composer holds it. */
export type AttachmentInput = {
  /** Absolute path the user picked, dropped, or a pasted image's temp file. */
  source: string;
  /** A name the user typed on the chip; sanitised again in main. */
  name?: string;
  /** The user typed the "Share anyway" confirmation for a secret-looking file. */
  shareAnyway?: boolean;
};

export type AttachmentVerdict = {
  source: string;
  /** The final, sanitised name: what the chip shows and what `commit` stores (before a clash suffix). */
  name: string;
  /** The name `commit` would store it under right now, clash suffix included (e.g. "whiteboard (2).jpg"). */
  storedName: string;
  size: number | null;
  mime: string;
  category: AttachmentCategory;
  /** PDFs only, when cheap to count. */
  pageCount?: number;
  disposition: AttachmentDisposition;
  /** Space-relative path for `link`/`reuse`. */
  linkPath?: string;
  state: AttachmentChipState;
  problems: AttachmentProblem[];
};

export type AttachmentSpaceStatus = 'ok' | 'viewer' | 'notLinked';

export type AttachmentSpaceCheck = {
  status: AttachmentSpaceStatus;
  /** Why attaching is off, when `status` isn't `ok`. */
  message?: string;
  /** Bytes of current files in the space, or null when unknown (offline and no local sync state). */
  usedBytes: number | null;
  /** `relay`: the space's file list on the relay (what the quota counts), plus attachments not synced yet. `local`: this computer's sync state (offline estimate). */
  usageSource: 'relay' | 'local' | null;
  limitBytes: number;
  /** Bytes these files would add (copies only; links, reuses and local-only files add nothing). */
  addingBytes: number;
  overQuota: boolean;
  quotaMessage?: string;
};

export type AttachmentPrepareResult = {
  space: AttachmentSpaceCheck;
  files: AttachmentVerdict[];
};

export type AttachmentCommitKind = 'copied' | 'linked' | 'local-only';

export type AttachmentCommitted = {
  source: string;
  /**
   * Space-relative (forward slashes) for `copied`/`linked`. For `local-only`,
   * space-relative when the file is in the space, else the absolute path on
   * this computer — never put that one in a message others see.
   */
  path: string;
  name: string;
  size: number;
  mime: string;
  /** `sha256:<hex>`, the same form the sync daemon records. Null for a local-only file over 25 MB (not worth reading). */
  hash: string | null;
  kind: AttachmentCommitKind;
};

export type AttachmentErrorKind =
  | 'notLinked'
  | 'viewer'
  | 'overQuota'
  | 'blocked'
  | 'copyFailed'
  | 'invalid';

export type AttachmentError = {
  kind: AttachmentErrorKind;
  message: string;
  /** The file it's about, when it's about one file (so the chip can show the reason). */
  source?: string;
};

export type AttachmentPastedImage = {
  /** Absolute path of the temp file, ready to use as an `AttachmentInput.source`. */
  path: string;
  name: string;
  size: number;
};

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
