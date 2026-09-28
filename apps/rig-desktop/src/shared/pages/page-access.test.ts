import { describe, expect, it } from 'vitest';
import { isNotSharedPage, pageNoun } from './page-access';

// Fixture page states (address, title, the start of the text), shaped like
// the sites' own "no access" pages; no real page is fetched.

const DOC = 'https://docs.google.com/document/d/1abc/edit';
const NEED_ACCESS = 'Google Docs\nYou need access\nRequest access, or switch to an account with access.\nRequest access\nYou are signed in as me@example.test';

describe('isNotSharedPage: Google', () => {
  it('spots the "You need access" page in place of the Doc', () => {
    expect(isNotSharedPage({ url: DOC, title: 'Google Docs', text: NEED_ACCESS })).toBe(true);
    expect(isNotSharedPage({ url: 'https://docs.google.com/spreadsheets/d/1abc/edit', text: 'You need access\nSwitch accounts' })).toBe(true);
  });

  it('spots the request-access address', () => {
    expect(isNotSharedPage({ url: 'https://docs.google.com/document/d/1abc/request-access?pli=1' })).toBe(true);
    expect(isNotSharedPage({ url: 'https://drive.google.com/drive/requestaccess?id=1abc' })).toBe(true);
    expect(isNotSharedPage({ url: 'https://docs.google.com/document/d/1abc/edit?requestaccess=1' })).toBe(true);
  });

  it('leaves real documents alone, even ones mentioning "you need access"', () => {
    expect(isNotSharedPage({ url: DOC, title: 'Q4 plan - Google Docs', text: 'Q4 plan\nIntro…' })).toBe(false);
    const longDoc = `How onboarding works. If you need access, request access from IT.\n${'lorem ipsum '.repeat(400)}`;
    expect(isNotSharedPage({ url: DOC, text: longDoc })).toBe(false);
    expect(isNotSharedPage({ url: DOC, text: 'You need access to a laptop.' })).toBe(false);
  });
});

describe('isNotSharedPage: claude.ai', () => {
  it('spots a private, deleted or unshared artifact or chat', () => {
    expect(isNotSharedPage({ url: 'https://claude.ai/public/artifacts/abc', text: 'Artifact not found' })).toBe(true);
    expect(isNotSharedPage({ url: 'https://claude.ai/artifacts/abc', text: 'This artifact is private.' })).toBe(true);
    expect(isNotSharedPage({ url: 'https://claude.ai/chat/abc', text: "You don't have access to this chat." })).toBe(true);
    expect(isNotSharedPage({ url: 'https://claude.ai/share/abc', title: 'Not found | Claude', text: '' })).toBe(true);
  });

  it('leaves real artifacts and other claude.ai pages alone', () => {
    expect(isNotSharedPage({ url: 'https://claude.ai/public/artifacts/abc', text: 'Pilot deck\nSlide 1: our plan' })).toBe(false);
    expect(isNotSharedPage({ url: 'https://claude.ai/recents', text: 'Not found' })).toBe(false);
    expect(isNotSharedPage({ url: 'https://claude.ai/public/artifacts/abc', text: `Error budget not found in logs.\n${'x'.repeat(4000)}` })).toBe(false);
  });
});

describe('isNotSharedPage: other sites', () => {
  it('never flags a site it does not know', () => {
    expect(isNotSharedPage({ url: 'https://www.notion.so/Roadmap', text: 'You need access. Request access.' })).toBe(false);
    expect(isNotSharedPage({ url: 'https://example.com/page', title: 'Not found', text: 'Not found' })).toBe(false);
    expect(isNotSharedPage({ url: 'not a url' })).toBe(false);
  });
});

describe('pageNoun', () => {
  it.each([
    [DOC, 'Doc'],
    ['https://docs.google.com/spreadsheets/d/1/edit', 'Sheet'],
    ['https://docs.google.com/presentation/d/1/edit', 'deck'],
    ['https://drive.google.com/file/d/1/view', 'file'],
    ['https://claude.ai/public/artifacts/abc', 'artifact'],
    ['https://claude.ai/chat/abc', 'chat'],
    ['https://www.notion.so/x', 'page'],
  ])('%s → %s', (url, noun) => {
    expect(pageNoun(url)).toBe(noun);
  });
});
