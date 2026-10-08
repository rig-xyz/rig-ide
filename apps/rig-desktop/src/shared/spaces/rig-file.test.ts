import { describe, expect, it } from 'vitest';
import { isHtmlPath, isRigFileUrl, parseRigFileUrl, rigFileUrl } from './rig-file';

describe('rigFileUrl', () => {
  it('encodes each step of the path and keeps the slashes', () => {
    expect(rigFileUrl('bnd_abc', 'site/my page.html')).toBe('rig-file://bnd_abc/site/my%20page.html');
    expect(rigFileUrl('bnd_abc', '/site//index.html')).toBe('rig-file://bnd_abc/site/index.html');
  });

  it('round-trips through parseRigFileUrl', () => {
    const url = rigFileUrl('bnd_abc', 'a/b c/#d?.html');
    expect(parseRigFileUrl(url)).toEqual({ bindingId: 'bnd_abc', relPath: 'a/b c/#d?.html' });
  });
});

describe('parseRigFileUrl', () => {
  it('reads the space and the path, without query or fragment', () => {
    expect(parseRigFileUrl('rig-file://bnd_abc/site/index.html?x=1#top')).toEqual({ bindingId: 'bnd_abc', relPath: 'site/index.html' });
    expect(parseRigFileUrl('RIG-FILE://BND_ABC/x.html')).toEqual({ bindingId: 'bnd_abc', relPath: 'x.html' });
    expect(parseRigFileUrl('rig-file://bnd_abc')).toEqual({ bindingId: 'bnd_abc', relPath: '' });
  });

  it.each([
    ['another scheme', 'https://bnd_abc/x.html'],
    ['a .. step', 'rig-file://bnd_abc/../x.html'],
    ['an encoded .. step', 'rig-file://bnd_abc/%2E%2E/x.html'],
    ['a . step', 'rig-file://bnd_abc/./x.html'],
    ['an encoded slash', 'rig-file://bnd_abc/a%2F..%2Fx.html'],
    ['a backslash', 'rig-file://bnd_abc/a%5Cx.html'],
    ['a NUL', 'rig-file://bnd_abc/x.html%00'],
    ['bad percent-encoding', 'rig-file://bnd_abc/%E0%A4%A'],
    ['a host with odd characters', 'rig-file://bnd abc/x.html'],
    ['no host', 'rig-file:///x.html'],
  ])('refuses %s', (_what, url) => {
    expect(parseRigFileUrl(url)).toBeNull();
  });

  it('knows its own links', () => {
    expect(isRigFileUrl('rig-file://bnd_abc/x')).toBe(true);
    expect(isRigFileUrl('rigfile:bnd_abc/x')).toBe(false);
  });
});

describe('isHtmlPath', () => {
  it.each([
    ['site/index.html', true],
    ['INDEX.HTM', true],
    ['index.html#intro', true],
    ['notes.md', false],
    ['page.html.md', false],
  ])('%s', (path, html) => {
    expect(isHtmlPath(path)).toBe(html);
  });
});
