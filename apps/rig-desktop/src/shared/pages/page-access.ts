/**
 * "This page isn't shared with <account>" (canvas board 18, case 8): the
 * person is signed in, but the page's own site says that account can't see
 * it. Only for sites whose "no access" page rig knows; any other site is
 * never flagged (a false "not shared" is worse than none).
 *
 * Pure: main reads the page's address, title and the start of its text
 * after it loads (the same post-load look as the sign-in-wall check) and
 * asks this.
 */

export interface LoadedPage {
  url: string;
  title?: string;
  /** The page's visible text, or its start (main reads a few thousand characters). */
  text?: string;
}

/** A "no access" page is short; a real document or chat mentioning these words is not. */
const SHORT_PAGE = 3_000;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Google Docs / Sheets / Slides / Drive: the "You need access" page, which
 * offers to request access or switch accounts. Google has served it both at
 * a request-access address and in place of the document, so both count.
 */
function googleNotShared(u: URL, page: LoadedPage): boolean {
  if (u.hostname !== 'docs.google.com' && u.hostname !== 'drive.google.com') return false;
  if (/\/request-?access\b/i.test(u.pathname) || /requestaccess/i.test(u.search)) return true;
  const text = page.text ?? '';
  if (text.length > SHORT_PAGE) return false;
  return /you need access/i.test(text) && /(request access|switch to an account|switch accounts?)/i.test(text);
}

/** claude.ai: a chat or artifact link that's private, deleted or not shared shows a short "not found / unavailable" page. */
function claudeNotShared(u: URL, page: LoadedPage): boolean {
  if (u.hostname !== 'claude.ai') return false;
  if (!/^\/(public\/artifacts|artifacts|share|chat)\//.test(u.pathname)) return false;
  const text = page.text ?? '';
  if (text.length > SHORT_PAGE) return false;
  const says = /(not found|isn['’]t available|is not available|unavailable|no longer available|doesn['’]t exist|does not exist|is private|(don['’]t|do not) have (access|permission))/i;
  return says.test(text) || says.test(page.title ?? '');
}

/** Whether a loaded page of a known site says the signed-in account can't see it. */
export function isNotSharedPage(page: LoadedPage): boolean {
  const u = parse(page.url);
  if (!u) return false;
  return googleNotShared(u, page) || claudeNotShared(u, page);
}

/** What the page is, for "This Doc isn't shared with …". */
export function pageNoun(url: string): string {
  const u = parse(url);
  if (!u) return 'page';
  if (u.hostname === 'docs.google.com') {
    if (u.pathname.startsWith('/document')) return 'Doc';
    if (u.pathname.startsWith('/spreadsheets')) return 'Sheet';
    if (u.pathname.startsWith('/presentation')) return 'deck';
    if (u.pathname.startsWith('/forms')) return 'form';
  }
  if (u.hostname === 'drive.google.com') return 'file';
  if (u.hostname === 'claude.ai') {
    if (/^\/(public\/artifacts|artifacts)\//.test(u.pathname)) return 'artifact';
    if (/^\/(chat|share)\//.test(u.pathname)) return 'chat';
  }
  return 'page';
}
