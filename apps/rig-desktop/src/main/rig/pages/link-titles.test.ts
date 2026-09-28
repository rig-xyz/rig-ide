import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('./agent-pages', () => ({ pagesSession: () => ({}) }));

const { cleanPageTitle, isTitledLink, linkTitle } = await import('./link-titles');

describe('cleanPageTitle', () => {
  it("drops the site's own suffix", () => {
    expect(cleanPageTitle('Homepage explorations | Claude')).toBe('Homepage explorations');
    expect(cleanPageTitle('Q4 plan - Google Docs')).toBe('Q4 plan');
    expect(cleanPageTitle('Budget - Google Sheets')).toBe('Budget');
  });

  it("names nothing for the site's name alone, a sign-in page or a bot check", () => {
    for (const raw of ['Claude', 'Google Docs', 'Sign in - Google Accounts', 'Just a moment...', 'Loading…', '  ']) {
      expect(cleanPageTitle(raw)).toBeNull();
    }
  });

  it('shortens a very long title', () => {
    expect(cleanPageTitle('x'.repeat(200))!.length).toBe(120);
  });
});

describe('linkTitle', () => {
  it('only ever loads the kinds of link rig recognises, never an arbitrary page', async () => {
    expect(isTitledLink('https://claude.ai/artifact/AbC')).toBe(true);
    expect(isTitledLink('https://docs.google.com/spreadsheets/d/1/edit')).toBe(true);
    expect(isTitledLink('https://github.com/rig-xyz/rig-ide')).toBe(false);
    expect(isTitledLink('https://attacker.example/track')).toBe(false);
    await expect(linkTitle('https://attacker.example/track')).resolves.toBeNull();
  });
});
