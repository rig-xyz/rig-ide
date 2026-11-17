import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileViewConsentStore, createOwnViewWrites } from './view-consent-store';

describe('createFileViewConsentStore', () => {
  it('remembers an accepted schedule across restarts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rig-consent-')), 'consent.json');
    createFileViewConsentStore(file).set('bnd_1/drafts', '3600000\nDraft.');
    expect(createFileViewConsentStore(file).get('bnd_1/drafts')).toBe('3600000\nDraft.');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'bnd_1/drafts': '3600000\nDraft.' });
  });
  it('treats an unreadable file as nothing accepted', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rig-consent-')), 'consent.json');
    writeFileSync(file, 'not json');
    expect(createFileViewConsentStore(file).get('bnd_1/drafts')).toBeUndefined();
  });
});

describe('createOwnViewWrites', () => {
  it('counts a write by this Mac\'s session for a few minutes, then no longer', () => {
    const clock = { now: 0 };
    const writes = createOwnViewWrites(() => clock.now, 180_000);
    expect(writes.wroteHere('bnd_1', 'drafts', 'a')).toBe(false);
    writes.mark('bnd_1', 'drafts', null);
    clock.now = 60_000;
    expect(writes.wroteHere('bnd_1', 'drafts', 'a')).toBe(true);
    expect(writes.wroteHere('bnd_1', 'inbox', 'a')).toBe(false);
    clock.now = 200_000;
    expect(writes.wroteHere('bnd_1', 'drafts', 'a')).toBe(false);
  });
  it('counts only the schedule the session wrote, when the write held the whole file', () => {
    const writes = createOwnViewWrites(() => 0);
    writes.mark('bnd_1', 'drafts', '3600000\nDraft.');
    expect(writes.wroteHere('bnd_1', 'drafts', '3600000\nDraft.')).toBe(true);
    expect(writes.wroteHere('bnd_1', 'drafts', '300000\nSend it all.')).toBe(false);
  });
});
