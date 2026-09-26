/**
 * What a link posted in a space points at, from its URL alone: a Claude
 * artifact or chat, a Google Doc/Sheet/Slides, something on GitHub, or any
 * other web page. The Room renders the known kinds as a chip; agents open
 * them their own way (Claude Docs through the owner's connector, and so on).
 */
export type LinkKind =
  | 'claude-artifact'
  | 'claude-chat'
  | 'google-doc'
  | 'google-sheet'
  | 'google-slides'
  | 'github'
  | 'web';

export interface LinkInfo {
  kind: LinkKind;
  /** What a chip says: "Claude artifact", "Google Doc", "acme/app" (GitHub). */
  label: string;
}

/** The browser profile pages open in (panel and agents alike); one of the app's registered browser partitions. */
export const RIG_PAGES_PARTITION = 'persist:emdash-browser-rig-pages';

/** `http(s)://…` up to whitespace or a quote/angle bracket. */
export const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;

/**
 * A URL as found in text, minus the punctuation that ends the sentence
 * around it: "see https://x.dev/a." links to https://x.dev/a. A closing
 * bracket is kept only when the URL opened one ("…/Foo_(bar)").
 */
export function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?]+$/, '');
  while (/[)\]]$/.test(url)) {
    const close = url.at(-1)!;
    const open = close === ')' ? '(' : '[';
    if (url.split(open).length >= url.split(close).length) break;
    url = url.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return url;
}

const GOOGLE: Record<string, { kind: LinkKind; label: string }> = {
  document: { kind: 'google-doc', label: 'Google Doc' },
  spreadsheets: { kind: 'google-sheet', label: 'Google Sheet' },
  presentation: { kind: 'google-slides', label: 'Google Slides' },
};

export function classifyLink(url: string): LinkInfo {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'web', label: url };
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (host === 'claude.ai' || host === 'preview.claude.ai') {
    // claude.ai/artifact/<id>, claude.ai/code/artifact/<id>, claude.ai/public/artifacts/<id>
    if (segments.some((s) => s === 'artifact' || s === 'artifacts')) return { kind: 'claude-artifact', label: 'Claude artifact' };
    if (segments[0] === 'share') return { kind: 'claude-chat', label: 'Claude chat' };
  }
  if (host === 'docs.google.com' && segments[1] === 'd') {
    const google = GOOGLE[segments[0] ?? ''];
    if (google) return google;
  }
  if (host === 'github.com' && segments.length >= 2) {
    return { kind: 'github', label: `${segments[0]}/${segments[1]}` };
  }
  return { kind: 'web', label: url };
}

/**
 * The form a page's link is stored in, so every member's copy of it matches
 * the same comments: no #fragment, and for Claude and Google documents no
 * query either (`?usp=sharing`, a title slug's version marker).
 */
export function canonicalPageUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.hash = '';
  const { kind } = classifyLink(url);
  if (kind !== 'web' && kind !== 'github') parsed.search = '';
  return parsed.toString();
}
