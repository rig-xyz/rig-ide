import type { NativeImage } from 'electron';
import { z } from 'zod';
import { agentPage, renderSnapshot } from './agent-pages';
import { EXPORT_MAX_BYTES, type GoogleExportResult } from './google-export';
import { frameBoards, frameBoardSnapshot, frameCall, type BoardInfo, type BoardSnapshot, type PageAnchor } from './page-frame-scripts';
import { contentFrameOf, locateOnPage } from './page-frames';

/**
 * Read-only browser tools for any room agent, served with rig's own tools
 * (so Claude and Codex both get them). They open a page as the agent's owner,
 * in a hidden tab of the agent's own, never in anyone's panel. The agent
 * decides what to read or look at; rig only says which pin a question is about.
 *
 * Shaped by the spike on a real claude.ai canvas (docs/arbitrary-artifacts-options.md):
 * boards are listed and read one at a time so nothing is cut off, and
 * screenshots re-render a board at full size so small text stays legible.
 */

export interface PagePin {
  n: number;
  comment: string;
  anchor: PageAnchor;
}

export interface BrowserToolsDeps {
  /** Pins (page comments) on this link in the agent's space, numbered as people see them. */
  pinsFor(url: string): Promise<PagePin[]>;
  /**
   * The page opened on a sign-in wall: returns what the agent is told
   * instead of the page (and lets the owner's chip know). Absent, the page
   * is read as it is.
   */
  signInWall?(url: string): Promise<string | null>;
  /**
   * Google Docs, Sheets and Slides draw on a canvas, so `browser_read` asks
   * for the file's own text export instead (`google-export.ts`). Null for
   * any other page; absent, every page is read as rendered.
   */
  fullText?(url: string): Promise<GoogleExportResult | null>;
}

export type BrowserToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' };

export interface BrowserToolResult {
  content: BrowserToolContent[];
  isError?: boolean;
}

export interface BrowserTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  run(input: Record<string, unknown>, deps: BrowserToolsDeps): Promise<BrowserToolResult>;
}

const say = (text: string, isError = false): BrowserToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

function image(img: NativeImage, text: string): BrowserToolResult {
  const sized = img.getSize().width > 1400 ? img.resize({ width: 1400 }) : img;
  return { content: [{ type: 'image', data: sized.toPNG().toString('base64'), mimeType: 'image/png' }, { type: 'text', text }] };
}

function webUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

async function boardsOf(url: string, withText: boolean): Promise<BoardInfo[]> {
  const page = await agentPage(url);
  return ((await contentFrameOf(page).frame.executeJavaScript(frameCall(frameBoards, withText))) as BoardInfo[] | null) ?? [];
}

async function snapshotOf(url: string, q: Parameters<typeof frameBoardSnapshot>[0]): Promise<BoardSnapshot | null> {
  const page = await agentPage(url);
  return (await contentFrameOf(page).frame.executeJavaScript(frameCall(frameBoardSnapshot, q))) as BoardSnapshot | null;
}

/** A crop around an element in a board snapshot, with some context. */
function around(snap: BoardSnapshot): { x: number; y: number; width: number; height: number } {
  const e = snap.el!;
  const width = Math.min(snap.w, Math.max(e.width * 2.2, 560));
  const height = Math.min(snap.h, Math.max(e.height * 4, 360));
  return {
    x: Math.min(Math.max(0, e.x + e.width / 2 - width / 2), snap.w - width),
    y: Math.min(Math.max(0, e.y + e.height / 2 - height / 2), snap.h - height),
    width,
    height,
  };
}

const URL_FIELD = z.string().describe('The page link, as posted in the space.');

export const BROWSER_TOOLS: readonly BrowserTool[] = [
  {
    name: 'browser_pins',
    title: 'Browser · pins',
    description:
      "The comments pinned on a page in this space: each pin's number, its comment, the board it's on and what it points at. Start here when someone asks about a pin.",
    inputSchema: { url: URL_FIELD },
    async run(input, deps) {
      const url = webUrl(input.url);
      if (!url) return say('Give the page link (http or https).', true);
      const pins = await deps.pinsFor(url);
      if (pins.length === 0) return say('No pins on this page.');
      const wall = await deps.signInWall?.(url);
      if (wall) return say(wall, true);
      const page = await agentPage(url);
      const boards = await boardsOf(url, false);
      const lines: string[] = [];
      for (const p of pins) {
        const at = await locateOnPage(page, p.anchor).catch(() => ({ found: false }));
        const b = boards.find((x) => x.i === p.anchor.hops[0]?.index);
        const what = p.anchor.text ? `a ${p.anchor.tag} reading "${p.anchor.text.slice(0, 80)}"` : `a ${p.anchor.tag} with no text (use browser_screenshot with this pin)`;
        lines.push(`Pin ${p.n}${at.found ? '' : ' (not on the page any more)'}: "${p.comment}" on ${b ? `board ${b.i} (${b.title.slice(0, 50)})` : 'the page'}, ${what}`);
      }
      return say(lines.join('\n'));
    },
  },
  {
    name: 'browser_read',
    title: 'Browser · read',
    description:
      "Read a page as your owner sees it. Without board: its title, a list of its boards (canvases and decks keep each board in its own frame), and the text of boards with pins or on screen. With board (words from a board's title, or its number): that board in full. A Google Doc, Sheet or Slides deck comes back as the whole file's text (a sheet as CSV of one tab: the link's #gid, else the first). Charts and images have no text: use browser_screenshot.",
    inputSchema: { url: URL_FIELD, board: z.union([z.string(), z.number()]).optional() },
    async run(input, deps) {
      const url = webUrl(input.url);
      if (!url) return say('Give the page link (http or https).', true);
      const wall = await deps.signInWall?.(url);
      if (wall) return say(wall, true);
      const page = await agentPage(url);
      const full = input.board === undefined ? await deps.fullText?.(url) : null;
      if (full?.ok) {
        const cut = full.truncated ? ` It was cut at ${EXPORT_MAX_BYTES / 1_000_000} MB: the rest of the file isn't here.` : '';
        return say(`${page.getTitle()} (${page.getURL()})\n\n[Full document text via ${full.label} export, not just what's on screen.${cut}]\n\n${full.text}`);
      }
      const why = full ? `[No full document text via ${full.label} export: ${full.why}. This is only what the page renders, which may be just the part on screen.]\n\n` : '';
      const all = await boardsOf(url, true);
      if (all.length === 0) {
        const text = String(await contentFrameOf(page).frame.executeJavaScript('document.body ? document.body.innerText : ""'));
        return say(`${page.getTitle()} (${page.getURL()})\n\n${why}${text.slice(0, 15000)}`);
      }
      const board = input.board;
      if (board !== undefined) {
        const b = typeof board === 'number' ? all.find((x) => x.i === board) : all.find((x) => x.text!.toLowerCase().includes(String(board).toLowerCase()));
        return b ? say(`Board ${b.i}: ${b.title}\n\n${b.text!.slice(0, 15000)}`) : say('No board matches that.', true);
      }
      const pinned = new Set((await deps.pinsFor(url)).map((p) => p.anchor.hops[0]?.index));
      const lines = [`${page.getTitle()} (${page.getURL()})`, '', ...(why ? [why.trimEnd(), ''] : []), `Boards (${all.length}):`];
      for (const b of all) lines.push(`- ${b.i}: ${b.title}${pinned.has(b.i) ? ' · has pins' : ''}${b.onScreen ? '' : ' · off screen'}`);
      let budget = 16_000;
      for (const b of [...all.filter((x) => pinned.has(x.i)), ...all.filter((x) => !pinned.has(x.i) && x.onScreen)]) {
        if (budget <= 0) break;
        const t = b.text!.slice(0, Math.min(budget, 6_000));
        budget -= t.length;
        lines.push('', `--- Board ${b.i}: ${b.title}`, t);
      }
      lines.push('', 'Read any other board in full with browser_read and its board.');
      return say(lines.join('\n'));
    },
  },
  {
    name: 'browser_screenshot',
    title: 'Browser · screenshot',
    description:
      "Look at part of a page as an image. pin (a pin number from browser_pins) or text (a phrase on the page) gives that element with context; board (words from a title, or its number) gives the whole board. Boards are re-rendered at full size, so they're legible whatever the zoom. With none of them: the top of the page.",
    inputSchema: {
      url: URL_FIELD,
      pin: z.number().int().optional(),
      board: z.union([z.string(), z.number()]).optional(),
      text: z.string().optional(),
    },
    async run(input, deps) {
      const url = webUrl(input.url);
      if (!url) return say('Give the page link (http or https).', true);
      const wall = await deps.signInWall?.(url);
      if (wall) return say(wall, true);
      if (typeof input.pin === 'number') {
        const p = (await deps.pinsFor(url)).find((x) => x.n === input.pin);
        if (!p) return say(`There's no pin ${input.pin} on this page.`, true);
        const hop = p.anchor.hops[0];
        const snap = await snapshotOf(url, { sig: hop?.sig, index: hop?.index, path: p.anchor.path, text: p.anchor.text || undefined });
        if (!snap || !snap.el) return say(`Pin ${p.n}'s element isn't on the page any more.`, true);
        return image(await renderSnapshot(snap.html, snap, around(snap)), `Pin ${p.n} with context, from board ${snap.i} at full size.`);
      }
      if (input.board !== undefined || typeof input.text === 'string') {
        const q =
          typeof input.board === 'number'
            ? { i: input.board, text: input.text as string | undefined }
            : { words: input.board as string | undefined, text: input.text as string | undefined };
        const snap = await snapshotOf(url, q);
        if (!snap) return say('No board matches that.', true);
        if (q.text && !snap.el) return say(`"${q.text}" isn't on board ${snap.i}.`, true);
        return image(
          await renderSnapshot(snap.html, snap, q.text ? around(snap) : null),
          q.text ? `"${q.text}" with context, from board ${snap.i} at full size.` : `Board ${snap.i} (${snap.title.slice(0, 50)}) at full size.`
        );
      }
      const page = await agentPage(url);
      return image(await page.capturePage(), 'The top of the page.');
    },
  },
];
