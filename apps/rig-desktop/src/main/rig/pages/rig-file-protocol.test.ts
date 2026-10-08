import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addFallbackReferer, mimeTypeFor, resolveRigFile, rigFileExternalUrl, rigFileRequestAllowed, rigFileResponse, type RigFileDeps } from './rig-file-protocol';

// A space folder on disk, bound as bnd_space; a nested rig inside it bound as bnd_other.
let base: string;
let root: string;
let deps: RigFileDeps;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'rig-file-')));
  root = join(base, 'space');
  mkdirSync(join(root, 'site', 'css'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'), '<link rel="stylesheet" href="css/app.css"><script src="app.js"></script>');
  writeFileSync(join(root, 'site', 'css', 'app.css'), 'body{}');
  writeFileSync(join(root, 'site', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, 'notes with space.html'), '<p>hi</p>');
  mkdirSync(join(root, '.rig'));
  writeFileSync(join(root, '.rig', 'tap-binding.local.json'), '{"token":"secret"}');
  writeFileSync(join(root, '.env'), 'KEY=1');
  writeFileSync(join(root, 'config.local.json'), '{}');
  writeFileSync(join(root, 'server.pem'), 'key');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'page.html'), 'other rig');
  writeFileSync(join(base, 'outside.html'), 'outside');
  symlinkSync(join(base, 'outside.html'), join(root, 'escape.html'));
  symlinkSync(base, join(root, 'up'));
  symlinkSync(join(root, '.rig', 'tap-binding.local.json'), join(root, 'token.json'));
  symlinkSync(join(root, 'site', 'index.html'), join(root, 'alias.html'));
  deps = {
    rootFor: async (id) => (id === 'bnd_space' ? root : null),
    bindingAt: (dir) => (dir.startsWith(join(root, 'nested')) ? 'bnd_other' : dir.startsWith(root) ? 'bnd_space' : null),
  };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const get = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  rigFileResponse(new Request(url, { method, headers }), deps);

describe('resolveRigFile', () => {
  it("finds a file in the space's folder", async () => {
    expect(await resolveRigFile(deps, 'bnd_space', 'site/css/app.css')).toEqual({ ok: true, absPath: join(root, 'site', 'css', 'app.css') });
  });

  it("serves a folder's index.html", async () => {
    expect(await resolveRigFile(deps, 'bnd_space', 'site')).toEqual({ ok: true, absPath: join(root, 'site', 'index.html') });
  });

  it('follows a symlink that stays inside the folder', async () => {
    expect(await resolveRigFile(deps, 'bnd_space', 'alias.html')).toEqual({ ok: true, absPath: join(root, 'site', 'index.html') });
  });

  it.each([
    ['a .. step', '../outside.html', 403],
    ['a .. step in the middle', 'site/../../outside.html', 403],
    ['a symlink to a file outside', 'escape.html', 403],
    ['a path through a symlinked folder outside', 'up/outside.html', 403],
    ['a symlink to a private file inside', 'token.json', 403],
    ['the sync binding', '.rig/tap-binding.local.json', 403],
    ['a hidden file', '.env', 403],
    ['a local-only file', 'config.local.json', 403],
    ['a file named like a key', 'server.pem', 403],
    ['a nested rig', 'nested/page.html', 403],
    ['a backslash', 'site\\index.html', 403],
    ['a missing file', 'site/nope.html', 404],
  ])('refuses %s', async (_what, path, status) => {
    expect(await resolveRigFile(deps, 'bnd_space', path)).toEqual({ ok: false, status });
  });

  it('only resolves spaces bound on this Mac', async () => {
    expect(await resolveRigFile(deps, 'bnd_elsewhere', 'site/index.html')).toEqual({ ok: false, status: 404 });
  });
});

describe('rigFileResponse', () => {
  it('serves the page with its MIME type, read only and never cached stale', async () => {
    const res = await get('rig-file://bnd_space/site/index.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await res.text()).toContain('app.js');
  });

  it("serves the page's relative assets to the page itself", async () => {
    const css = await get('rig-file://bnd_space/site/css/app.css', { referer: 'rig-file://bnd_space/site/index.html' });
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const js = await get('rig-file://bnd_space/site/app.js', { origin: 'rig-file://bnd_space' });
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('decodes encoded names and ignores the query and fragment', async () => {
    const res = await get('rig-file://bnd_space/notes%20with%20space.html?x=1#top');
    expect(await res.text()).toBe('<p>hi</p>');
  });

  it.each([
    ['another site', { origin: 'https://evil.example' }],
    ['another site, by referer', { referer: 'https://evil.example/page' }],
    ['another space', { referer: 'rig-file://bnd_other/x.html' }],
    ['an opaque origin', { origin: 'null' }],
  ])('refuses a request from %s', async (_what, headers) => {
    expect((await get('rig-file://bnd_space/site/app.js', headers)).status).toBe(403);
  });

  it('an encoded .. step is folded into the path by the URL parser and stays inside', async () => {
    const res = await get('rig-file://bnd_space/site/%2e%2e/%2e%2e/outside.html');
    expect(res.status).toBe(404);
  });

  it.each([
    ['an encoded slash', 'rig-file://bnd_space/site%2f..%2f..%2foutside.html'],
    ['an encoded backslash', 'rig-file://bnd_space/..%5coutside.html'],
    ['a NUL', 'rig-file://bnd_space/site/index.html%00.png'],
    ['bad percent-encoding', 'rig-file://bnd_space/%E0%A4%A'],
  ])('refuses %s', async (_what, url) => {
    expect((await get(url)).status).toBe(403);
  });

  it('only reads', async () => {
    expect((await get('rig-file://bnd_space/site/index.html', {}, 'POST')).status).toBe(405);
    const head = await get('rig-file://bnd_space/site/index.html', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('says not found for a space that is not on this Mac', async () => {
    expect((await get('rig-file://bnd_elsewhere/index.html')).status).toBe(404);
  });
});

describe('rigFileRequestAllowed', () => {
  it('lets a page open on its own, and pull in files of its own space', () => {
    expect(rigFileRequestAllowed('rig-file://bnd_a/site/index.html', 'mainFrame', null)).toBe(true);
    expect(rigFileRequestAllowed('rig-file://bnd_a/site/app.js', 'script', 'rig-file://bnd_a/site/index.html')).toBe(true);
    expect(rigFileRequestAllowed('rig-file://bnd_a/data.json', 'xhr', 'rig-file://bnd_a/site/index.html')).toBe(true);
    expect(rigFileRequestAllowed('rig-file://bnd_a/frame.html', 'subFrame', 'rig-file://bnd_a/site/index.html')).toBe(true);
  });

  it.each([
    ['a web page', 'https://evil.example/'],
    ['another space', 'rig-file://bnd_b/index.html'],
    ['no page at all', null],
  ])('refuses files pulled in by %s', (_what, requester) => {
    for (const type of ['image', 'script', 'stylesheet', 'xhr', 'subFrame', 'media', 'font']) {
      expect(rigFileRequestAllowed('rig-file://bnd_a/site/app.js', type, requester)).toBe(false);
    }
  });

  it('refuses an unsafe link whatever asks', () => {
    expect(rigFileRequestAllowed('rig-file://bnd_a/../x', 'mainFrame', null)).toBe(false);
  });
});

describe('mimeTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['INDEX.HTM', 'text/html; charset=utf-8'],
    ['app.mjs', 'text/javascript; charset=utf-8'],
    ['data.json', 'application/json; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['photo.JPG', 'image/jpeg'],
    ['font.woff2', 'font/woff2'],
    ['clip.mp4', 'video/mp4'],
    ['module.wasm', 'application/wasm'],
    ['notes.md', 'text/markdown; charset=utf-8'],
    ['blob.bin', 'application/octet-stream'],
    ['Makefile', 'application/octet-stream'],
  ])('%s is %s', (name, type) => {
    expect(mimeTypeFor(name)).toBe(type);
  });
});

describe('addFallbackReferer', () => {
  const run = (url: string, headers: Record<string, string> = {}) => {
    addFallbackReferer(url, headers);
    return headers;
  };

  it('gives an http(s) request with no Referer Rig\'s own', () => {
    expect(run('https://tile.openstreetmap.org/3/4/2.png', { Accept: 'image/png' })).toEqual({ Accept: 'image/png', Referer: 'https://userig.xyz/' });
    expect(run('http://example.com/a.js')).toEqual({ Referer: 'https://userig.xyz/' });
  });

  it('leaves a request that already has a Referer as it is, whatever its case', () => {
    expect(run('https://tile.openstreetmap.org/a.png', { Referer: 'https://a.example/' })).toEqual({ Referer: 'https://a.example/' });
    expect(run('https://tile.openstreetmap.org/a.png', { referer: 'https://a.example/' })).toEqual({ referer: 'https://a.example/' });
  });

  it('never touches rig-file:// or other schemes', () => {
    expect(run('rig-file://bnd_space/site/index.html')).toEqual({});
    expect(run('data:image/png;base64,AAAA')).toEqual({});
    expect(run('ws://example.com/socket')).toEqual({});
  });
});

describe('rigFileExternalUrl', () => {
  it("is the real file's file:// URL, a folder's index.html for a folder", async () => {
    expect(await rigFileExternalUrl(deps, 'rig-file://bnd_space/site/css/app.css')).toBe(pathToFileURL(join(root, 'site', 'css', 'app.css')).href);
    expect(await rigFileExternalUrl(deps, 'rig-file://bnd_space/site/')).toBe(pathToFileURL(join(root, 'site', 'index.html')).href);
    expect(await rigFileExternalUrl(deps, 'rig-file://bnd_space/notes%20with%20space.html')).toBe(pathToFileURL(join(root, 'notes with space.html')).href);
  });

  it('opens nothing the protocol refuses', async () => {
    for (const path of ['.env', 'escape.html', 'token.json', 'nested/page.html', 'missing.html', 'server.pem']) {
      expect(await rigFileExternalUrl(deps, `rig-file://bnd_space/${path}`)).toBeNull();
    }
    expect(await rigFileExternalUrl(deps, 'rig-file://bnd_unknown/site/index.html')).toBeNull();
    expect(await rigFileExternalUrl(deps, 'https://example.com/')).toBeNull();
  });
});
