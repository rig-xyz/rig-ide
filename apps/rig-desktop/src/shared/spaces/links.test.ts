import { describe, expect, it } from 'vitest';
import { canonicalPageUrl, classifyLink, opensBesideChat, trimUrl, webLinkLabel } from './links';

describe('classifyLink', () => {
  it.each([
    ['https://claude.ai/artifact/6NZfLXaEewFt55zQ5tMn7d', 'claude-artifact', 'Claude artifact'],
    ['https://claude.ai/code/artifact/2b8070c5-6987-49a4-8f8b-0c8589581ae4', 'claude-artifact', 'Claude artifact'],
    ['https://claude.ai/artifact/pilot-plan-6NZfLXaEewFt55zQ5tMn7d?v=2#top', 'claude-artifact', 'Claude artifact'],
    ['https://claude.ai/public/artifacts/0b1c2d3e-aaaa-bbbb-cccc-123456789012', 'claude-artifact', 'Claude artifact'],
    ['https://claude.ai/share/7f3e2a10-1111-2222-3333-444455556666', 'claude-chat', 'Claude chat'],
    ['https://docs.google.com/document/d/1AbC/edit?usp=sharing', 'google-doc', 'Google Doc'],
    ['https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0', 'google-sheet', 'Google Sheet'],
    ['https://docs.google.com/presentation/d/1AbC/edit', 'google-slides', 'Google Slides'],
    ['https://github.com/rig-xyz/rig-ide', 'github', 'rig-xyz/rig-ide'],
    ['https://www.github.com/rig-xyz/rig-ide/pull/12', 'github', 'rig-xyz/rig-ide'],
  ] as const)('%s → %s', (url, kind, label) => {
    expect(classifyLink(url)).toEqual({ kind, label });
  });

  it('treats everything else as a web page, including pages on the same hosts that are not documents', () => {
    for (const url of [
      'https://userig.xyz/download',
      'https://claude.ai/new',
      'https://docs.google.com/forms/d/1AbC/viewform',
      'https://github.com/rig-xyz',
      'not a url',
    ]) {
      expect(classifyLink(url).kind).toBe('web');
    }
  });
});

describe('trimUrl', () => {
  it('drops the punctuation that ends the sentence, not the URL', () => {
    expect(trimUrl('https://x.dev/a.')).toBe('https://x.dev/a');
    expect(trimUrl('https://x.dev/a?b=1,')).toBe('https://x.dev/a?b=1');
    expect(trimUrl('https://x.dev/a)')).toBe('https://x.dev/a');
    expect(trimUrl('https://x.dev/a).')).toBe('https://x.dev/a');
    expect(trimUrl('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });
});

describe('canonicalPageUrl', () => {
  it('drops what differs between copies of the same document link', () => {
    expect(canonicalPageUrl('https://claude.ai/artifact/6NZf?v=2#top')).toBe('https://claude.ai/artifact/6NZf');
    expect(canonicalPageUrl('https://docs.google.com/document/d/1AbC/edit?usp=sharing')).toBe('https://docs.google.com/document/d/1AbC/edit');
    // Anywhere else the query can matter, only the fragment goes.
    expect(canonicalPageUrl('https://example.com/report?id=7#s2')).toBe('https://example.com/report?id=7');
  });
});

describe('opensBesideChat', () => {
  it.each([
    'https://example.com/report?id=7',
    'http://localhost:3000/',
    'https://docs.google.com/document/d/1AbC/edit',
    'https://github.com/rig-xyz/rig-ide',
    'https://userig.xyz/download',
  ])('%s opens beside the chat', (url) => {
    expect(opensBesideChat(url)).toBe(true);
  });

  it.each([
    'mailto:sam@acme.com',
    'slack://channel?team=T1&id=C1',
    'vscode://file/Users/sam/app.ts',
    'https://zoom.us/j/123456',
    'https://acme.zoom.us/j/123456?pwd=x',
    'https://meet.google.com/abc-defg-hij',
    'https://teams.microsoft.com/l/meetup-join/19%3a',
    'https://dl.userig.xyz/Rig-0.4.5-arm64.dmg',
    'https://example.com/files/export.ZIP',
    'https://example.com/a/archive.tar.gz',
    'https://example.com/setup.exe',
    'https://example.com/Installer.pkg',
    'https://cdn.example.com/demo.mp4?t=3',
    'https://cdn.example.com/clip.mov',
    'not a url',
  ])('%s goes to the browser (or its own app)', (url) => {
    expect(opensBesideChat(url)).toBe(false);
  });
});

describe('webLinkLabel', () => {
  it.each([
    ['https://www.userig.xyz/download', 'userig.xyz/download'],
    ['https://example.com', 'example.com'],
    ['https://example.com/?q=1#top', 'example.com'],
    ['https://notion.so/acme/Plan-123', 'notion.so/acme'],
    ['https://example.com/caf%C3%A9', 'example.com/café'],
    ['https://example.com/a-very-long-first-path-segment-indeed', 'example.com/a-very-long-first-path-…'],
  ])('%s → %s', (url, label) => {
    expect(webLinkLabel(url)).toBe(label);
  });
});
