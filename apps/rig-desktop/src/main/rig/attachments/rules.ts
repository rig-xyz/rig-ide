import ignore, { type Ignore } from 'ignore';
import { ATTACHMENTS_DIR } from '@shared/rig/attachments';

/**
 * Which attachments look like secrets, and which the sync daemon would never
 * ship (local-only). Pure: the caller reads the bytes and the space's
 * `.tapignore`.
 */

// ── secrets ──

const SECRET_NAMES: RegExp[] = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$|dist$).+$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.keychain(-db)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
];

const SECRET_CONTENT: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\b[rs]k_live_[A-Za-z0-9]{16,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\brpat_[A-Za-z0-9_-]{16,}/,
  // key = value assignments with a real-looking value
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** How many leading bytes are scanned for tokens. */
export const SECRET_SCAN_BYTES = 1024;

/** Why the file looks like a secret, or null. `head` is the file's first KB (skipped when it looks binary). */
export function secretReason(name: string, head: Uint8Array | null): string | null {
  if (SECRET_NAMES.some((re) => re.test(name))) return 'name';
  if (!head || head.length === 0 || head.includes(0)) return null;
  const text = Buffer.from(head.subarray(0, SECRET_SCAN_BYTES)).toString('utf8');
  return SECRET_CONTENT.some((re) => re.test(text)) ? 'content' : null;
}

// ── local-only: what sync never ships ──

/**
 * The sync daemon's built-in ignore rules (tap `packages/tapd/src/tapignore.ts`,
 * BUILTIN_IGNORE_LINES), mirrored. Directory rules are left out: an
 * attachment is a single file.
 */
const SYNC_BUILTIN_IGNORE = [
  '.env',
  '.env.*',
  '*.local.*',
  '*.pyc',
  '.DS_Store',
  '*.mov',
  '*.mp4',
  '*.zip',
  '*.tar.gz',
  '*.sqlite',
  '*.conflict-from.*',
];

/**
 * Videos and archives are normal attachments (decided on board 19): these
 * negations let them sync inside `attachments/`. `commit` writes them to the
 * space's `.tapignore` before copying one (older daemons only honour that).
 */
export const ATTACHMENT_SYNC_EXCEPTIONS = [
  `!${ATTACHMENTS_DIR}/**/*.mov`,
  `!${ATTACHMENTS_DIR}/**/*.mp4`,
  `!${ATTACHMENTS_DIR}/**/*.zip`,
  `!${ATTACHMENTS_DIR}/**/*.tar.gz`,
];

/** True for the file types that need `ATTACHMENT_SYNC_EXCEPTIONS` in `.tapignore` to sync. */
export function needsSyncException(name: string): boolean {
  return /\.(mov|mp4|zip|tar\.gz)$/i.test(name);
}

/** A matcher for "would sync skip this space-relative path?", given the space's `.tapignore` text. */
export function syncIgnoreMatcher(tapignore: string | null): (relPath: string) => boolean {
  const ig: Ignore = ignore();
  ig.add(SYNC_BUILTIN_IGNORE.join('\n'));
  if (tapignore) ig.add(tapignore);
  ig.add(ATTACHMENT_SYNC_EXCEPTIONS.join('\n'));
  return (relPath) => relPath === '.rig' || relPath.startsWith('.rig/') || ig.ignores(relPath);
}

/**
 * `.tapignore` text with the attachment exceptions appended (only the
 * missing ones, after one comment line), or null when nothing is missing.
 * Never removes or reorders a line.
 */
export function withSyncExceptions(existing: string | null): string | null {
  const lines = new Set((existing ?? '').split(/\r?\n/).map((line) => line.trim()));
  const missing = ATTACHMENT_SYNC_EXCEPTIONS.filter((line) => !lines.has(line));
  if (missing.length === 0) return null;
  const base = existing ?? '';
  const separator = base === '' || base.endsWith('\n') ? '' : '\n';
  const comment = '# Let videos and archives attached in the chat sync (rig attachments)';
  return `${base}${separator}${comment}\n${missing.join('\n')}\n`;
}

// ── PDF page count ──

/** Page count from `/Type /Page` objects; null when none are visible (compressed object streams hide them). */
export function pdfPageCount(bytes: Uint8Array): number | null {
  const text = Buffer.from(bytes).toString('latin1');
  const matches = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return matches && matches.length > 0 ? matches.length : null;
}
