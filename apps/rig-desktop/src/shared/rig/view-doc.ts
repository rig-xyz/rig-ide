/**
 * The document a Rig view runs as inside its sandboxed frame. Ported from the host spike
 * (`rig-views/host-spike/host.js`, `buildDoc`), unchanged in what it allows.
 *
 * The view's own file is only its layout. The host supplies the rest: the stylesheet and runtime
 * that ship with the app, in place of the page's `../_rig/` tags, and a content policy that is the
 * first thing in `<head>`, so it is in force before any of the page's own markup is parsed. Under
 * it the page can run its inline script and style and show `data:` images and fonts; every network
 * load is refused.
 */
export const VIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** The frame's whole permission set: scripts, and nothing else (no same-origin, forms, popups, top navigation). */
export const VIEW_SANDBOX = 'allow-scripts';

const inertScript = (code: string) => code.replace(/<\/script/gi, '<\\/script');
const inertStyle = (css: string) => css.replace(/<\/style/gi, '<\\/style');

/**
 * `theme` is the app's own light or dark, which a person can set apart from their system's. The
 * stylesheet follows the system unless the document says otherwise, so the document says it.
 */
export function buildViewDoc(
  html: string,
  css: string,
  runtime: string,
  theme: 'light' | 'dark' | null = null
): string {
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">` +
    `<style>${inertStyle(css)}</style>` +
    `<script>${inertScript(runtime)}</script>`;
  const doc = html
    .replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy[^>]*>/gi, '')
    .replace(/<link[^>]+_rig\/rig\.css[^>]*>/gi, '')
    .replace(/<script[^>]+_rig\/rig-view\.js[^>]*>\s*<\/script>/gi, '');
  // A function replacement: the runtime and stylesheet contain `$`, which a string replacement would read as a pattern.
  const themed = (page: string) =>
    theme
      ? page.replace(
          /<html\b([^>]*)>/i,
          (_tag, rest: string) =>
            `<html${rest.replace(/\sdata-theme=("[^"]*"|'[^']*'|\S+)/i, '')} data-theme="${theme}">`
        )
      : page;
  if (/<head[^>]*>/i.test(doc)) {
    const withHead = doc.replace(/<head[^>]*>/i, (tag) => tag + head);
    return /<html\b/i.test(withHead) ? themed(withHead) : withHead;
  }
  return themed(`<!doctype html><html><head>${head}</head><body>${doc}</body></html>`);
}
