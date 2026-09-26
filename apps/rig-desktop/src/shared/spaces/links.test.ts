import { describe, expect, it } from 'vitest';
import { canonicalPageUrl, classifyLink, trimUrl } from './links';

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
