import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, session } from 'electron';
import { z } from 'zod';
import { buildViewDoc, VIEW_SANDBOX } from '@shared/rig/view-doc';
import { isViewName, viewDataPath, viewIndexPath } from '@shared/rig/views';
import viewRuntime from '../../../renderer/features/views/_runtime/rig-view.hosted.js?raw';
import viewCss from '../../../renderer/features/views/_runtime/rig.css?raw';
import type { RigTool, RigToolScope } from '../spaces/rig-tools';

/**
 * Lets a space's agent look at one of the space's views the way its owner sees it (spike, Rig
 * Alpha): the view is drawn off screen exactly as the app hosts it (the same document, runtime,
 * stylesheet and sandbox, fed the same `data.json`), and the agent gets the picture, plus anything
 * the page wrote to the console as an error. Without it an agent can only read a view's source,
 * and has to ask the person whether the page looks right.
 *
 * The page is the agent's own code, so it is held as tightly as in the app: its frame may run
 * scripts and nothing else, its content policy refuses every network load, and the window around
 * it has its own throwaway session in which every request but the one local wrapper file is
 * cancelled.
 */
export const VIEW_LOOK_TOOL = 'rig_view_look';

const WIDTH = 1200;
const DEFAULT_HEIGHT = 1800;
const MAX_HEIGHT = 6000;
const PAGE_MAX_BYTES = 2_000_000;
const DATA_MAX_BYTES = 12_000_000;
/** How long the page gets to draw after its data arrives. */
const SETTLE_MS = 1200;

export type ViewLook = { png: Buffer; errors: string[]; hadData: boolean };

async function readCapped(file: string, max: number): Promise<string | null> {
  try {
    if ((await stat(file)).size > max) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** The page around the view's frame: it does what the app's host does, and nothing else. */
export function lookWrapper(doc: string, dataText: string | null, viewer: { id: string; name: string | null }): string {
  // `<` escaped so nothing in the view's own text can end this script early.
  const payload = JSON.stringify({ doc, text: dataText, viewer }).replace(/</g, '\\u003c');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;height:100%;background:#121519}iframe{border:0;width:100%;height:100%;display:block}</style>',
    `</head><body><iframe id="view" sandbox="${VIEW_SANDBOX}"></iframe><script>`,
    `const payload = ${payload};`,
    'const frame = document.getElementById("view");',
    'window.addEventListener("message", (event) => {',
    '  if (event.source !== frame.contentWindow || !event.data || event.data.type !== "rig:ready") return;',
    '  if (payload.text !== null) frame.contentWindow.postMessage({ type: "rig:data", text: payload.text, viewer: payload.viewer, people: [] }, "*");',
    '});',
    'frame.srcdoc = payload.doc;',
    '</script></body></html>',
  ].join('\n');
}

/** Draws a view of the space at `root` off screen and returns what it looks like. Null when the view has no page. */
export async function lookAtView(input: {
  root: string;
  view: string;
  viewer: { id: string; name: string | null };
  height?: number;
}): Promise<ViewLook | null> {
  const html = await readCapped(join(input.root, viewIndexPath(input.view)), PAGE_MAX_BYTES);
  if (html === null) return null;
  const raw = await readCapped(join(input.root, viewDataPath(input.view)), DATA_MAX_BYTES);
  let dataText: string | null = null;
  try {
    dataText = raw === null ? null : JSON.stringify(JSON.parse(raw));
  } catch {
    dataText = null;
  }
  const dir = await mkdtemp(join(tmpdir(), 'rig-view-look-'));
  const file = join(dir, 'look.html');
  await writeFile(file, lookWrapper(buildViewDoc(html, viewCss, viewRuntime, 'dark'), dataText, input.viewer), 'utf8');
  const wrapperUrl = pathToFileURL(file).toString();

  const ses = session.fromPartition(`rig-view-look-${randomUUID()}`, { cache: false });
  // Only the wrapper file itself loads; the view's own policy already refuses the network.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = details.url === wrapperUrl || details.url.startsWith('about:') || details.url.startsWith('data:');
    callback({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  const height = Math.max(400, Math.min(MAX_HEIGHT, Math.round(input.height ?? DEFAULT_HEIGHT)));
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height,
    webPreferences: {
      offscreen: true,
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const errors: string[] = [];
  // Errors from the view's frame arrive here too: what a person would find in the console.
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { level?: unknown; message?: unknown } | undefined;
    const level = typeof first?.level === 'string' ? first.level : typeof args[1] === 'number' ? (args[1] >= 3 ? 'error' : '') : '';
    const message = typeof first?.message === 'string' ? first.message : typeof args[2] === 'string' ? args[2] : '';
    if (level === 'error' && message && errors.length < 8) errors.push(message.slice(0, 300));
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await win.loadURL(wrapperUrl);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const image = await win.webContents.capturePage();
    return { png: image.toPNG(), errors, hadData: dataText !== null };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The tool a space session calls: one of its own space's views, as its owner sees it. */
export function viewLookTool(deps: { look?: typeof lookAtView } = {}): RigTool {
  const look = deps.look ?? lookAtView;
  return {
    name: VIEW_LOOK_TOOL,
    description:
      "Show one of this space's views as an image, drawn the way your owner sees its tab, with any errors the page wrote. Use it whenever you made or changed a view, before you say it is done: check the layout, that the data shows, and that nothing is cut off or broken, and fix what is wrong. " +
      'view is the folder name under views/. height is how far down to draw, in pixels (default 1800): raise it for a long page.',
    inputSchema: {
      view: z.string().describe("The view's folder name under views/, e.g. drafts."),
      height: z.number().int().optional().describe('How many pixels of the page to draw, from the top (default 1800, at most 6000).'),
    },
    annotations: { title: 'Look at a view', readOnlyHint: true },
    run: async (scope: RigToolScope, input) => {
      const view = String(input.view ?? '').trim();
      if (!isViewName(view)) return { text: `"${view}" is not a view's folder name. Give the name of a folder under views/.`, isError: true };
      const result = await look({
        root: scope.cwd,
        view,
        viewer: { id: scope.ownerUserId, name: null },
        ...(typeof input.height === 'number' ? { height: input.height } : {}),
      }).catch((error: unknown) => ({ failed: String(error) }) as const);
      if (result === null) return { text: `There is no views/${view}/index.html in this space (or it is too large to draw).`, isError: true };
      if ('failed' in result) return { text: `Couldn't draw the view: ${result.failed}`, isError: true };
      const notes = [
        `The ${view} view as your owner sees it, ${WIDTH}px wide, from the top.`,
        result.hadData ? '' : 'Its data.json is missing or not valid JSON, so the page drew without data.',
        result.errors.length > 0 ? `The page wrote ${result.errors.length === 1 ? 'an error' : 'errors'}:\n${result.errors.map((e) => `- ${e}`).join('\n')}` : 'The page wrote no errors.',
      ].filter(Boolean);
      const text = notes.join('\n');
      return { text, content: [{ type: 'image', data: result.png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text }] };
    },
  };
}
