import { describe, expect, it } from 'vitest';
import type { AttachmentCommitted, AttachmentFileStatus, AttachmentVerdict, MessageAttachment } from '@shared/rig/attachments';
import {
  cardSettled,
  cardStatus,
  chipDetail,
  composerSummary,
  fallbackBody,
  isLargeBatch,
  parseMessageAttachments,
  toMessageAttachments,
  type ComposerAttachment,
} from './attachments';

const committed = (over: Partial<AttachmentCommitted>): AttachmentCommitted => ({
  source: '/Users/me/Desktop/a.pdf',
  path: 'attachments/a.pdf',
  name: 'a.pdf',
  size: 10,
  mime: 'application/pdf',
  hash: 'sha256:aa',
  kind: 'copied',
  ...over,
});

const status = (over: Partial<AttachmentFileStatus>): AttachmentFileStatus => ({
  path: 'attachments/a.pdf',
  exists: true,
  synced: false,
  onRelay: null,
  ...over,
});

const file: MessageAttachment = { name: 'a.pdf', size: 10, mime: 'application/pdf', kind: 'copied', path: 'attachments/a.pdf' };

describe('toMessageAttachments', () => {
  it('never carries an absolute path: local-only files are named only', () => {
    const out = toMessageAttachments([
      committed({}),
      committed({ source: '/Users/me/app.sqlite', path: '/Users/me/app.sqlite', name: 'app.sqlite', kind: 'local-only', hash: null }),
      committed({ path: '/etc/passwd', kind: 'linked' }),
    ]);
    expect(out[0]).toEqual({ name: 'a.pdf', size: 10, mime: 'application/pdf', kind: 'copied', path: 'attachments/a.pdf', hash: 'sha256:aa' });
    expect(out[1]).toEqual({ name: 'app.sqlite', size: 10, mime: 'application/pdf', kind: 'local-only' });
    expect(out[2]!.path).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('/Users/');
  });

  it('keeps the page count the chip found', () => {
    const verdict = { pageCount: 18 } as AttachmentVerdict;
    expect(toMessageAttachments([committed({})], new Map([['/Users/me/Desktop/a.pdf', verdict]]))[0]!.pages).toBe(18);
  });
});

describe('parseMessageAttachments', () => {
  it('checks shapes and drops unsafe paths written by another app', () => {
    const parsed = parseMessageAttachments([
      { name: 'a.pdf', size: 10, mime: 'application/pdf', kind: 'copied', path: 'attachments/a.pdf', hash: 'sha256:x' },
      { name: 'evil', size: 1, mime: 'x', kind: 'copied', path: '../../etc/passwd' },
      { name: 'local', size: 1, mime: 'x', kind: 'local-only', path: 'attachments/local' },
      { nope: true },
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed![0]!.path).toBe('attachments/a.pdf');
    expect(parsed![1]!.path).toBeUndefined();
    expect(parsed![2]!.path).toBeUndefined();
    expect(parseMessageAttachments('x')).toBeUndefined();
    expect(parseMessageAttachments([])).toBeUndefined();
  });
});

describe('fallbackBody', () => {
  it('says what was shared when there is no text', () => {
    expect(fallbackBody([file])).toBe('Shared a.pdf');
    expect(fallbackBody([file, file])).toBe('Shared 2 files');
  });
});

describe('cardStatus', () => {
  const base = { senderName: 'Dylan', messageAgeMs: 1000 };
  it('follows your own file until it has synced', () => {
    expect(cardStatus({ ...base, attachment: file, mine: true, status: status({ synced: false }) })?.label).toBe('Syncing…');
    expect(cardStatus({ ...base, attachment: file, mine: true, status: status({ synced: true }) })?.label).toBe('Synced');
    expect(cardStatus({ ...base, attachment: file, mine: true, status: status({ synced: null }) })?.label).toBe('Added');
    expect(cardStatus({ ...base, attachment: file, mine: true, status: status({ notSynced: 'overQuota' }) })?.label).toBe(
      'Not synced: over the space’s 50 MB'
    );
    expect(cardStatus({ ...base, attachment: file, mine: true, status: status({ exists: false }) })?.label).toBe('Removed from the space');
    expect(cardStatus({ ...base, attachment: file, mine: true, status: status({}), sending: true })).toBeNull();
  });

  it("says others' files are arriving until they're here, removed only once deleted on the relay", () => {
    expect(cardStatus({ ...base, attachment: file, mine: false, status: status({ exists: false, onRelay: true }) })?.label).toBe(
      'Arriving from Dylan…'
    );
    expect(cardStatus({ ...base, attachment: file, mine: false, status: status({ exists: false, onRelay: false }) })?.label).toBe(
      'Arriving from Dylan…'
    );
    // Never reached the relay: the sender's sync is behind, nobody removed it; keep checking.
    const late = cardStatus({ ...base, messageAgeMs: 60 * 60 * 1000, attachment: file, mine: false, status: status({ exists: false, onRelay: false }) });
    expect(late?.label).toBe('Dylan’s computer hasn’t shared it yet');
    expect(cardSettled(late, file, false)).toBe(false);
    // Deleted on the relay: removed, whatever its age.
    expect(
      cardStatus({ ...base, attachment: file, mine: false, status: status({ exists: false, onRelay: false, deletedOnRelay: true }) })?.label
    ).toBe('Removed from the space');
    expect(cardStatus({ ...base, attachment: file, mine: false, status: status({ exists: true }) })).toBeNull();
  });

  it("names whose computer a local-only file is on", () => {
    const local: MessageAttachment = { name: 'app.sqlite', size: 1, mime: 'x', kind: 'local-only' };
    expect(cardStatus({ ...base, attachment: local, mine: false, status: undefined })?.label).toBe('Only on Dylan’s computer');
    expect(cardStatus({ ...base, attachment: local, mine: true, status: undefined })?.label).toBe('Only on your computer');
    expect(cardSettled(null, local, true)).toBe(true);
  });

  it('keeps checking only while something can still change', () => {
    expect(cardSettled({ label: 'Syncing…', short: 'syncing', tone: 'muted' }, file, true)).toBe(false);
    expect(cardSettled({ label: 'Synced', short: 'synced', tone: 'ok' }, file, true)).toBe(true);
    expect(cardSettled({ label: 'Arriving from Dylan…', short: 'arriving', tone: 'muted' }, file, false)).toBe(false);
    expect(cardSettled(null, file, false)).toBe(true);
  });
});

describe('composer chips', () => {
  const verdict = (over: Partial<AttachmentVerdict>): AttachmentVerdict => ({
    source: '/a',
    name: 'a.pdf',
    storedName: 'a.pdf',
    size: 4.2 * 1024 * 1024,
    mime: 'application/pdf',
    category: 'pdf',
    disposition: 'copy',
    state: 'ok',
    problems: [],
    ...over,
  });
  const chip = (over: Partial<ComposerAttachment>): ComposerAttachment => ({ id: 'c', source: '/a', verdict: verdict({}), ...over });

  it('describes size, pages and problems', () => {
    expect(chipDetail(chip({ verdict: verdict({ pageCount: 18 }) }))).toBe('4.2 MB · 18 pages');
    expect(chipDetail(chip({ verdict: verdict({ size: 31 * 1024 * 1024, problems: [{ kind: 'tooLarge', message: 'x' }] }) }))).toBe(
      '31 MB · over 25 MB'
    );
    // Before main's checks: the size it was added with, no "checking" label.
    expect(chipDetail(chip({ verdict: undefined }))).toBe('');
    expect(chipDetail(chip({ verdict: undefined, size: 2048 }))).toBe('2 KB');
    expect(chipDetail(chip({ error: 'The disk is full.' }))).toBe('The disk is full.');
  });

  it('sums the files and folds a big batch', () => {
    expect(composerSummary([chip({}), chip({ id: 'd' })]).label).toBe('2 files · 8.4 MB');
    expect(isLargeBatch(Array.from({ length: 21 }, (_, i) => chip({ id: String(i), verdict: verdict({ size: 1 }) })))).toBe(true);
    expect(isLargeBatch([chip({ verdict: verdict({ size: 41 * 1024 * 1024 }) })])).toBe(true);
    expect(isLargeBatch([chip({})])).toBe(false);
  });
});
