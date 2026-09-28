import { BrowserWindow } from 'electron';
import { canonicalPageUrl, classifyLink, type LinkKind } from '@shared/spaces/links';
import { pagesSession } from './agent-pages';

/**
 * The name behind a link chip in the chat ("Pilot deck" rather than "Claude
 * artifact"). Claude and Google pages set their title with script (and
 * claude.ai answers a plain request with a bot check), so the page is loaded
 * in a hidden tab of the pages browser, signed in as the person, and its
 * title read once it settles.
 *
 * Only for the kinds of link rig already recognises: loading a page is a
 * visit, so arbitrary links in a message are never fetched on sight. One
 * load per link per run, two at a time; a link that can't be named (signed
 * out, not shared with you, a timeout) resolves to null and the chip keeps
 * its generic label.
 */

const TITLED_KINDS: ReadonlySet<LinkKind> = new Set(['claude-artifact', 'claude-chat', 'google-doc', 'google-sheet', 'google-slides']);
const LOAD_TIMEOUT_MS = 12_000;
/** After the first real title, a short wait for the page to replace it with a better one. */
const SETTLE_MS = 800;
const MAX_CONCURRENT = 2;
const NO_TITLE_RETRY_MS = 10 * 60_000;

const SUFFIXES = [/\s*[|\-–—]\s*Claude$/i, /\s*-\s*Google (Docs|Sheets|Slides|Drive)$/i];
const GENERIC = /^(claude|google (docs|sheets|slides|drive)|sign in.*|log in.*|just a moment.*|untitled.*|loading.*|)$/i;

/** A page's title as a chip label: the site's own suffix dropped; null when it names nothing (the site's name, a sign-in page, a bot check). */
export function cleanPageTitle(raw: string): string | null {
  let title = raw.trim();
  for (const suffix of SUFFIXES) title = title.replace(suffix, '').trim();
  if (GENERIC.test(title)) return null;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

export function isTitledLink(url: string): boolean {
  return TITLED_KINDS.has(classifyLink(url).kind);
}

const cache = new Map<string, Promise<string | null>>();
let running = 0;
const queue: (() => void)[] = [];

async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => queue.push(resolve));
  running++;
  try {
    return await run();
  } finally {
    running--;
    queue.shift()?.();
  }
}

function loadTitle(url: string): Promise<string | null> {
  return slot(
    () =>
      new Promise<string | null>((resolve) => {
        const win = new BrowserWindow({
          show: false,
          width: 1280,
          height: 800,
          webPreferences: { session: pagesSession(), sandbox: true, contextIsolation: true },
        });
        let best: string | null = null;
        let settle: NodeJS.Timeout | null = null;
        const done = () => {
          clearTimeout(timeout);
          if (settle) clearTimeout(settle);
          if (!win.isDestroyed()) win.destroy();
          resolve(best);
        };
        const timeout = setTimeout(done, LOAD_TIMEOUT_MS);
        win.webContents.on('page-title-updated', (_event, raw) => {
          const title = cleanPageTitle(raw);
          if (!title) return;
          best = title;
          if (settle) clearTimeout(settle);
          settle = setTimeout(done, SETTLE_MS);
        });
        // Nothing the page opens goes anywhere.
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.loadURL(url).catch(() => {
          if (!best) done();
        });
      })
  );
}

export function linkTitle(url: string): Promise<string | null> {
  if (!isTitledLink(url)) return Promise.resolve(null);
  const key = canonicalPageUrl(url);
  let title = cache.get(key);
  if (!title) {
    title = loadTitle(key);
    cache.set(key, title);
    // Unnamed (signed out, not shared yet): try again later rather than never.
    void title.then((name) => {
      if (name === null) setTimeout(() => cache.delete(key), NO_TITLE_RETRY_MS).unref();
    });
  }
  return title;
}
