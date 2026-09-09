import { describe, expect, it } from 'vitest';
import { extractFileMentionCandidates, linkPulseFileMentions } from './pulse-file-mentions';

const BID = 'bind123';

describe('extractFileMentionCandidates', () => {
  it('extracts a bare mention', () => {
    expect(extractFileMentionCandidates('Eight edits to untitled-1.md over the past 36 hours.')).toEqual([
      'untitled-1.md',
    ]);
  });

  it('extracts a backticked mention', () => {
    expect(
      extractFileMentionCandidates(
        'Added a **Quick start** section to `rigs/content/drafts/2026-09-03-what-is-rig.md`.'
      )
    ).toEqual(['rigs/content/drafts/2026-09-03-what-is-rig.md']);
  });

  it('extracts a quoted mention, spaces and all', () => {
    expect(extractFileMentionCandidates('Renamed "What is Rig - a simple guide.md" just now')).toEqual([
      'What is Rig - a simple guide.md',
    ]);
  });

  it('does not extract bold text with no extension', () => {
    expect(extractFileMentionCandidates('Added a **Quick start** section')).toEqual([]);
  });

  it('extracts a bold mention that does look like a file', () => {
    expect(extractFileMentionCandidates('Rewrote **notes.md** entirely')).toEqual(['notes.md']);
  });

  it('never extracts a mention from inside a fenced code block', () => {
    expect(extractFileMentionCandidates('see below\n```\nopen(notes.md)\n```\ndone')).toEqual([]);
  });

  it('never extracts a mention from inside an existing markdown link', () => {
    expect(extractFileMentionCandidates('see [notes.md](https://example.com/notes.md)')).toEqual([]);
  });

  it('does not extract a run whose extension the artifact pane cannot show', () => {
    expect(extractFileMentionCandidates('see logo.png now')).toEqual([]);
  });

  it('dedupes repeated mentions of the same file', () => {
    expect(extractFileMentionCandidates('notes.md then notes.md again')).toEqual(['notes.md']);
  });
});

describe('linkPulseFileMentions', () => {
  it('links a bare resolved mention', () => {
    const out = linkPulseFileMentions('see untitled-1.md now', BID, { 'untitled-1.md': 'untitled-1.md' });
    expect(out).toBe(`see [untitled-1.md](rigfile:${BID}/untitled-1.md) now`);
  });

  it('links a quoted resolved mention, leaving the quotes as plain text', () => {
    const out = linkPulseFileMentions('Renamed "guide.md" just now', BID, { 'guide.md': 'docs/guide.md' });
    expect(out).toBe(`Renamed "[guide.md](rigfile:${BID}/docs%2Fguide.md)" just now`);
  });

  it('links a bold resolved mention, leaving the ** as plain text', () => {
    const out = linkPulseFileMentions('Rewrote **notes.md** entirely', BID, { 'notes.md': 'notes.md' });
    expect(out).toBe(`Rewrote **[notes.md](rigfile:${BID}/notes.md)** entirely`);
  });

  it('links a backticked resolved mention as a code span WRAPPED BY the link', () => {
    const out = linkPulseFileMentions('see `rigs/drafts/notes.md` now', BID, {
      'rigs/drafts/notes.md': 'rigs/drafts/notes.md',
    });
    expect(out).toBe(`see [\`rigs/drafts/notes.md\`](rigfile:${BID}/rigs%2Fdrafts%2Fnotes.md) now`);
  });

  it('URL-encodes a relPath with slashes so exactly one literal "/" follows the bindingId', () => {
    const out = linkPulseFileMentions('see notes.md now', BID, { 'notes.md': 'a/b/notes.md' });
    const href = out.match(/\((rigfile:[^)]+)\)/)?.[1];
    expect(href).toBe(`rigfile:${BID}/a%2Fb%2Fnotes.md`);
    // Exactly one real "/" separates the bindingId from the (fully encoded) relPath.
    expect(href?.slice('rigfile:'.length).split('/')).toHaveLength(2);
  });

  it('leaves an unresolved mention (candidate resolves to null) exactly as written', () => {
    const out = linkPulseFileMentions('see missing.md now', BID, { 'missing.md': null });
    expect(out).toBe('see missing.md now');
  });

  it('leaves a mention this pass was never asked about exactly as written', () => {
    const out = linkPulseFileMentions('see notes.md now', BID, {});
    expect(out).toBe('see notes.md now');
  });

  it('leaves an existing markdown link entirely untouched even when its text looks like a resolved mention', () => {
    const out = linkPulseFileMentions('see [notes.md](https://example.com) now', BID, {
      'notes.md': 'notes.md',
    });
    expect(out).toBe('see [notes.md](https://example.com) now');
  });

  it('leaves a fenced code block entirely untouched even when it names a resolved mention', () => {
    const out = linkPulseFileMentions('```\nopen(notes.md)\n```', BID, { 'notes.md': 'notes.md' });
    expect(out).toBe('```\nopen(notes.md)\n```');
  });

  it('links every distinct resolved mention in one string', () => {
    const out = linkPulseFileMentions('see notes.md and draft.md', BID, {
      'notes.md': 'notes.md',
      'draft.md': 'draft.md',
    });
    expect(out).toBe(
      `see [notes.md](rigfile:${BID}/notes.md) and [draft.md](rigfile:${BID}/draft.md)`
    );
  });

  it('is a no-op on an empty resolved map', () => {
    expect(linkPulseFileMentions('see notes.md now', BID, {})).toBe('see notes.md now');
  });
});
