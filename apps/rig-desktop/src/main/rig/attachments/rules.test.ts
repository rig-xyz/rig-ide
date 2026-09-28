import { describe, expect, it } from 'vitest';
import { extensionOf, foldName, mimeOf, numberedName, sanitizeAttachmentName } from './names';
import {
  ATTACHMENT_SYNC_EXCEPTIONS,
  needsSyncException,
  pdfPageCount,
  secretReason,
  syncIgnoreMatcher,
  withSyncExceptions,
} from './rules';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('sanitizeAttachmentName', () => {
  it('normalises NFD accents to NFC', () => {
    const nfd = 'Café.pdf';
    expect(sanitizeAttachmentName(nfd)).toBe('Café.pdf');
    expect(sanitizeAttachmentName(nfd).normalize('NFC')).toBe(sanitizeAttachmentName(nfd));
  });

  it('replaces unsafe and control characters', () => {
    expect(sanitizeAttachmentName('a/b\\c:d*e?"f<g>h|i.txt')).toBe('a_b_c_d_e__f_g_h_i.txt');
    expect(sanitizeAttachmentName('tab\there\u0000.md')).toBe('tabhere.md');
  });

  it('suffixes Windows reserved names and trims trailing dots/spaces', () => {
    expect(sanitizeAttachmentName('CON.txt')).toBe('CON_.txt');
    expect(sanitizeAttachmentName('notes. . ')).toBe('notes');
    expect(sanitizeAttachmentName('   ')).toBe('file');
    expect(sanitizeAttachmentName('..')).toBe('file');
  });

  it('clips to 255 bytes keeping the extension, including a clash suffix', () => {
    const long = `${'é'.repeat(300)}.pdf`;
    const clipped = sanitizeAttachmentName(long);
    expect(Buffer.byteLength(clipped, 'utf8')).toBeLessThanOrEqual(255);
    expect(clipped.endsWith('.pdf')).toBe(true);
    const numbered = numberedName(long, 2);
    expect(Buffer.byteLength(numbered, 'utf8')).toBeLessThanOrEqual(255);
    expect(numbered.endsWith(' (2).pdf')).toBe(true);
  });

  it('numbers before compound extensions', () => {
    expect(numberedName('backup.tar.gz', 2)).toBe('backup (2).tar.gz');
    expect(numberedName('whiteboard.jpg', 1)).toBe('whiteboard.jpg');
    expect(numberedName('README', 3)).toBe('README (3)');
    expect(extensionOf('.env')).toBe('');
  });

  it('folds case and normalisation for clash checks', () => {
    expect(foldName('Whiteboard.JPG')).toBe(foldName('whiteboard.jpg'));
    expect(foldName('Café.pdf')).toBe(foldName('café.PDF'));
  });

  it('maps extensions to mime and category', () => {
    expect(mimeOf('deck.PDF')).toEqual({ mime: 'application/pdf', category: 'pdf' });
    expect(mimeOf('shot.png').category).toBe('image');
    expect(mimeOf('demo.mp4').category).toBe('video');
    expect(mimeOf('backup.tar.gz').category).toBe('archive');
    expect(mimeOf('mystery').mime).toBe('application/octet-stream');
  });
});

describe('secretReason', () => {
  it('flags secret file names', () => {
    for (const name of ['.env', '.env.production', 'server.pem', 'id_rsa', 'cert.p12', 'login.keychain-db']) {
      expect(secretReason(name, null)).toBe('name');
    }
    expect(secretReason('.env.example', null)).toBeNull();
    expect(secretReason('id_rsa.pub', null)).toBeNull();
  });

  it('flags tokens and private keys in the first KB of text', () => {
    expect(secretReason('notes.txt', bytes('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'))).toBe('content');
    expect(secretReason('config.json', bytes('{"key": "AKIAABCDEFGHIJKLMNOP"}'))).toBe('content');
    expect(secretReason('a.txt', bytes('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'))).toBe('content');
    expect(secretReason('a.txt', bytes('password = hunter2hunter2'))).toBe('content');
  });

  it('leaves ordinary text and binary files alone', () => {
    expect(secretReason('notes.md', bytes('# Notes\nThe password policy is documented elsewhere.'))).toBeNull();
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, ...bytes('AKIAABCDEFGHIJKLMNOP')]);
    expect(secretReason('shot.png', binary)).toBeNull();
  });

  it('only scans the first KB', () => {
    const late = bytes(`${'x'.repeat(2048)} AKIAABCDEFGHIJKLMNOP`);
    expect(secretReason('big.txt', late)).toBeNull();
  });
});

describe('sync rules', () => {
  it('treats what sync never ships as local-only', () => {
    const ignored = syncIgnoreMatcher(null);
    expect(ignored('attachments/data.sqlite')).toBe(true);
    expect(ignored('attachments/.env')).toBe(true);
    expect(ignored('attachments/notes.local.md')).toBe(true);
    expect(ignored('.rig/tap/state.local.db')).toBe(true);
    expect(ignored('attachments/deck.pdf')).toBe(false);
  });

  it('lets videos and archives sync inside attachments/ only', () => {
    const ignored = syncIgnoreMatcher(null);
    expect(ignored('attachments/demo.mp4')).toBe(false);
    expect(ignored('attachments/backup.tar.gz')).toBe(false);
    expect(ignored('attachments/clip.MOV')).toBe(false);
    expect(ignored('videos/demo.mp4')).toBe(true);
  });

  it("honours the space's .tapignore", () => {
    const ignored = syncIgnoreMatcher('*.psd\n');
    expect(ignored('attachments/art.psd')).toBe(true);
  });

  it('knows which types need the .tapignore exceptions', () => {
    expect(needsSyncException('demo.mp4')).toBe(true);
    expect(needsSyncException('a.tar.gz')).toBe(true);
    expect(needsSyncException('deck.pdf')).toBe(false);
  });
});

describe('withSyncExceptions', () => {
  it('creates the lines when there is no .tapignore', () => {
    const next = withSyncExceptions(null)!;
    expect(next.startsWith('# ')).toBe(true);
    for (const line of ATTACHMENT_SYNC_EXCEPTIONS) expect(next).toContain(`${line}\n`);
  });

  it('appends only the missing lines, keeping existing ones in order', () => {
    const existing = `*.psd\n${ATTACHMENT_SYNC_EXCEPTIONS[0]}\nbuild/`;
    const next = withSyncExceptions(existing)!;
    expect(next.startsWith(`${existing}\n`)).toBe(true);
    expect(next.split(ATTACHMENT_SYNC_EXCEPTIONS[0]!).length).toBe(2);
    for (const line of ATTACHMENT_SYNC_EXCEPTIONS.slice(1)) expect(next).toContain(line);
  });

  it('is idempotent', () => {
    const once = withSyncExceptions('node_modules/\n')!;
    expect(withSyncExceptions(once)).toBeNull();
  });
});

describe('pdfPageCount', () => {
  it('counts page objects, not the page tree', () => {
    const pdf = bytes('%PDF-1.4\n1 0 obj <</Type /Pages /Count 2>>\n2 0 obj <</Type /Page>>\n3 0 obj <</Type/Page>>');
    expect(pdfPageCount(pdf)).toBe(2);
    expect(pdfPageCount(bytes('%PDF-1.7 compressed'))).toBeNull();
  });
});
