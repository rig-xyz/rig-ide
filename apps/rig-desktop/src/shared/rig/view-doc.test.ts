import { describe, expect, it } from 'vitest';
import { buildViewDoc, VIEW_CSP, VIEW_SANDBOX } from './view-doc';

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src *">
<link rel="stylesheet" href="../_rig/rig.css"><script src="../_rig/rig-view.js"></script>
</head><body><main id="root"></main><script>rig.mount(() => '')</script></body></html>`;

describe('buildViewDoc', () => {
  it('puts the policy, stylesheet and runtime first in head, in place of the page tags', () => {
    const doc = buildViewDoc(PAGE, 'body{color:red}', 'window.rig={}');
    const head = doc.indexOf('<head>') + '<head>'.length;
    expect(doc.slice(head)).toMatch(
      /^<meta http-equiv="Content-Security-Policy" content="default-src 'none'[^"]*"><style>body\{color:red\}<\/style><script>window\.rig=\{\}<\/script>/
    );
    expect(doc).not.toContain('_rig/');
    expect(doc).not.toContain('default-src *');
    expect(doc).toContain("rig.mount(() => '')");
  });
  it('keeps injected code from closing its own tag, and $ in it literal', () => {
    const doc = buildViewDoc(PAGE, 'a::after{content:"</style>"}', 'const s = "</script>$&$1";');
    expect(doc).toContain('const s = "<\\/script>$&$1";');
    expect(doc).toContain('content:"<\\/style>"');
  });
  it('wraps a page that has no head', () => {
    expect(buildViewDoc('<p>hi</p>', '', '')).toMatch(
      /^<!doctype html><html><head><meta http-equiv/
    );
  });
  it("says the app's theme on the document, over whatever the page wrote", () => {
    expect(buildViewDoc(PAGE, '', '', 'dark')).toMatch(/<html data-theme="dark">/);
    expect(
      buildViewDoc(
        '<html lang="en" data-theme="light"><head></head><body></body></html>',
        '',
        '',
        'dark'
      )
    ).toMatch(/<html lang="en" data-theme="dark">/);
    expect(buildViewDoc('<p>hi</p>', '', '', 'light')).toMatch(
      /^<!doctype html><html data-theme="light">/
    );
    expect(buildViewDoc(PAGE, '', '')).not.toContain('data-theme');
  });
  it('allows scripts and nothing else', () => {
    expect(VIEW_SANDBOX).toBe('allow-scripts');
    expect(VIEW_CSP).toContain("default-src 'none'");
    expect(VIEW_CSP).not.toMatch(/https?:|\*|connect-src/);
  });
});
