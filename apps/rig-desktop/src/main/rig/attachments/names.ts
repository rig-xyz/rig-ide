import type { AttachmentCategory } from '@shared/rig/attachments';

/**
 * Attachment file names: what a picked file is stored as in `attachments/`.
 * Pure string work, no filesystem.
 */

const MAX_NAME_BYTES = 255;
// Unsafe on some platform we sync to (Windows is the strictest), or a path separator.
const UNSAFE_CHARS = /[\\/:*?"<>|]/g;
// Control characters, which the relay rejects in paths (tap core validateRigPath).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Multi-part extensions kept whole when clipping or numbering a name.
const COMPOUND_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz'];

/** The extension, including the dot and compound forms like `.tar.gz`; '' when none (a leading-dot name like `.env` has none). */
export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(ext) && lower.length > ext.length) return name.slice(-ext.length);
  }
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Clip `value` to at most `maxBytes` of UTF-8, never splitting a character. */
function clipBytes(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let out = '';
  for (const char of value) {
    if (utf8Length(out + char) > maxBytes) break;
    out += char;
  }
  return out;
}

/**
 * The name a file is stored under: Unicode NFC (macOS hands us NFD accents),
 * unsafe and control characters replaced with `_`, trailing dots/spaces
 * trimmed, Windows reserved names suffixed, clipped to 255 bytes with the
 * extension kept. `suffix` (e.g. " (2)") goes before the extension and is
 * counted in the limit.
 */
export function sanitizeAttachmentName(raw: string, suffix = ''): string {
  let name = raw.normalize('NFC').replace(CONTROL_CHARS, '').replace(UNSAFE_CHARS, '_').trim();
  name = name.replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'file';
  let ext = extensionOf(name);
  let stem = ext ? name.slice(0, -ext.length) : name;
  if (WINDOWS_RESERVED.test(stem)) stem = `${stem}_`;
  // An absurd "extension" (a dot near the start of a long name) isn't worth keeping whole.
  if (utf8Length(ext) > 32) {
    stem = name;
    ext = '';
  }
  const budget = MAX_NAME_BYTES - utf8Length(ext) - utf8Length(suffix);
  stem = clipBytes(stem, budget).replace(/[. ]+$/, '') || 'file';
  return `${stem}${suffix}${ext}`;
}

/** The name for the nth copy: "name.ext", "name (2).ext", "name (3).ext"… */
export function numberedName(raw: string, n: number): string {
  return sanitizeAttachmentName(raw, n <= 1 ? '' : ` (${n})`);
}

/** Case- and normalisation-insensitive key, the same fold tap uses for path clashes (NFC + lower case). */
export function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

const MIME_BY_EXT: Record<string, [string, AttachmentCategory]> = {
  '.png': ['image/png', 'image'],
  '.jpg': ['image/jpeg', 'image'],
  '.jpeg': ['image/jpeg', 'image'],
  '.gif': ['image/gif', 'image'],
  '.webp': ['image/webp', 'image'],
  '.heic': ['image/heic', 'image'],
  '.heif': ['image/heif', 'image'],
  '.svg': ['image/svg+xml', 'image'],
  '.bmp': ['image/bmp', 'image'],
  '.tif': ['image/tiff', 'image'],
  '.tiff': ['image/tiff', 'image'],
  '.pdf': ['application/pdf', 'pdf'],
  '.doc': ['application/msword', 'doc'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc'],
  '.pages': ['application/vnd.apple.pages', 'doc'],
  '.rtf': ['application/rtf', 'doc'],
  '.odt': ['application/vnd.oasis.opendocument.text', 'doc'],
  '.xls': ['application/vnd.ms-excel', 'sheet'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet'],
  '.numbers': ['application/vnd.apple.numbers', 'sheet'],
  '.csv': ['text/csv', 'sheet'],
  '.tsv': ['text/tab-separated-values', 'sheet'],
  '.ppt': ['application/vnd.ms-powerpoint', 'slides'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slides'],
  '.key': ['application/vnd.apple.keynote', 'slides'],
  '.md': ['text/markdown', 'text'],
  '.mdx': ['text/markdown', 'text'],
  '.txt': ['text/plain', 'text'],
  '.json': ['application/json', 'text'],
  '.yaml': ['application/yaml', 'text'],
  '.yml': ['application/yaml', 'text'],
  '.toml': ['application/toml', 'text'],
  '.html': ['text/html', 'text'],
  '.xml': ['application/xml', 'text'],
  '.mp4': ['video/mp4', 'video'],
  '.mov': ['video/quicktime', 'video'],
  '.webm': ['video/webm', 'video'],
  '.m4v': ['video/x-m4v', 'video'],
  '.mp3': ['audio/mpeg', 'audio'],
  '.m4a': ['audio/mp4', 'audio'],
  '.wav': ['audio/wav', 'audio'],
  '.aac': ['audio/aac', 'audio'],
  '.ogg': ['audio/ogg', 'audio'],
  '.flac': ['audio/flac', 'audio'],
  '.zip': ['application/zip', 'archive'],
  '.tar.gz': ['application/gzip', 'archive'],
  '.tgz': ['application/gzip', 'archive'],
  '.gz': ['application/gzip', 'archive'],
  '.7z': ['application/x-7z-compressed', 'archive'],
  '.rar': ['application/vnd.rar', 'archive'],
  '.sqlite': ['application/vnd.sqlite3', 'data'],
  '.sqlite3': ['application/vnd.sqlite3', 'data'],
  '.db': ['application/octet-stream', 'data'],
  '.parquet': ['application/vnd.apache.parquet', 'data'],
};

/** Mime type and chip category from the name's extension. */
export function mimeOf(name: string): { mime: string; category: AttachmentCategory } {
  const hit = MIME_BY_EXT[extensionOf(name).toLowerCase()];
  return hit ? { mime: hit[0], category: hit[1] } : { mime: 'application/octet-stream', category: 'other' };
}
