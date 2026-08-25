import { describe, expect, it } from 'vitest';
import { fileLinks, rigLinks, stripIdentifiers, stripRigPrefix, summarySegments } from './summary-segments';

/**
 * The real case that prompted this: Dylan's own summary, IDs and all.
 */
const REAL = [
  'You have three open intents across your rigs: two duplicate architecture designs',
  'for the cycling system (int_gs05m2 and int_9xq2), an agent session underway in',
  "rig-bike (int_krk0a5), and a post-release review in cto-rig (int_yjm0ca) that's",
  'now four days old. Most recent work is a grammar review sitting in test-google-import.',
].join(' ');

const RIGS = [
  { bindingId: 'bnd_bike', rigName: 'rig-bike' },
  { bindingId: 'bnd_cto', rigName: 'cto-rig' },
  { bindingId: 'bnd_import', rigName: 'test-google-import' },
];

describe('stripIdentifiers', () => {
  it('removes an ID citation and the parenthetical that held it', () => {
    expect(stripIdentifiers('an agent session underway in rig-bike (int_krk0a5), and more')).toBe(
      'an agent session underway in rig-bike, and more'
    );
  });

  it('removes a parenthetical holding several IDs joined by a word', () => {
    expect(stripIdentifiers('two duplicate designs (int_gs05m2 and int_9xq2), then')).toBe(
      'two duplicate designs, then'
    );
  });

  it('leaves prose without identifiers untouched', () => {
    const plain = 'Most recent work is a grammar review sitting in test-google-import.';
    expect(stripIdentifiers(plain)).toBe(plain);
  });

  it('leaves no identifier anywhere in the real summary', () => {
    expect(stripIdentifiers(REAL)).not.toMatch(/int_|bnd_/);
  });

  it('never leaves an empty parenthetical or a space before punctuation behind', () => {
    const cleaned = stripIdentifiers(REAL);
    expect(cleaned).not.toMatch(/\(\s*\)/);
    expect(cleaned).not.toMatch(/\s+[,.]/);
  });
});

describe('summarySegments', () => {
  it('turns every known rig name into a link carrying its bindingId', () => {
    const linked = summarySegments(REAL, rigLinks(RIGS)).filter((s) => s.kind === 'link');
    expect(linked.map((s) => s.text)).toEqual(['rig-bike', 'cto-rig', 'test-google-import']);
    expect(linked.map((s) => (s.kind === 'link' && s.target.kind === 'rig' ? s.target.bindingId : null))).toEqual([
      'bnd_bike',
      'bnd_cto',
      'bnd_import',
    ]);
  });

  it('reassembles to exactly the cleaned text, so linking never edits the prose', () => {
    const rebuilt = summarySegments(REAL, rigLinks(RIGS))
      .map((s) => s.text)
      .join('');
    expect(rebuilt).toBe(stripIdentifiers(REAL));
  });

  it('prefers the longest name so a prefix rig cannot swallow a longer one', () => {
    const segments = summarySegments(
      'work landed in rig-bike-old today',
      rigLinks([
        { bindingId: 'bnd_short', rigName: 'rig-bike' },
        { bindingId: 'bnd_long', rigName: 'rig-bike-old' },
      ])
    );
    const linked = segments.filter((s) => s.kind === 'link');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ text: 'rig-bike-old', target: { bindingId: 'bnd_long' } });
  });

  it('matches case-insensitively but shows the words the model actually wrote', () => {
    const segments = summarySegments('Rig-Bike is busy', rigLinks([{ bindingId: 'b', rigName: 'rig-bike' }]));
    expect(segments.find((s) => s.kind === 'link')?.text).toBe('Rig-Bike');
  });

  it('links a rig named more than once, every time', () => {
    const segments = summarySegments('rig-bike then rig-bike again', rigLinks([
      { bindingId: 'b', rigName: 'rig-bike' },
    ]));
    expect(segments.filter((s) => s.kind === 'link')).toHaveLength(2);
  });

  it('returns plain text when the reader has no rigs to link to', () => {
    expect(summarySegments('a plain sentence', [])).toEqual([{ kind: 'text', text: 'a plain sentence' }]);
  });

  it('returns nothing for a summary that was only an identifier', () => {
    expect(summarySegments('int_abc123', rigLinks(RIGS))).toEqual([]);
  });

  it('ignores a rig whose name is blank rather than matching every gap', () => {
    const segments = summarySegments('some work', rigLinks([{ bindingId: 'b', rigName: '   ' }]));
    expect(segments).toEqual([{ kind: 'text', text: 'some work' }]);
  });
});

describe('file links', () => {
  it('links a file the narration names, carrying its real path', () => {
    const segments = summarySegments(
      'Updated untitled-1.md today.',
      fileLinks([{ relPath: 'notes/untitled-1.md' }])
    );
    const linked = segments.find((s) => s.kind === 'link');
    expect(linked).toMatchObject({ text: 'untitled-1.md', target: { relPath: 'notes/untitled-1.md' } });
  });

  it('matches the basename, since narration never writes the full path', () => {
    const segments = summarySegments('see profile.md', fileLinks([{ relPath: 'training/profile.md' }]));
    expect(segments.filter((s) => s.kind === 'link')).toHaveLength(1);
  });

  it('links rigs and files in the same sentence', () => {
    const segments = summarySegments('rig-bike: updated profile.md', [
      ...rigLinks([{ bindingId: 'b', rigName: 'rig-bike' }]),
      ...fileLinks([{ relPath: 'training/profile.md' }]),
    ]);
    const kinds = segments.filter((s) => s.kind === 'link').map((s) => (s.kind === 'link' ? s.target.kind : null));
    expect(kinds).toEqual(['rig', 'file']);
  });
});

describe('stripRigPrefix', () => {
  it('drops the rig prefix so the line reads as a sentence', () => {
    expect(stripRigPrefix('rig-bike: Updated untitled-1.md today.', 'rig-bike')).toBe(
      'Updated untitled-1.md today.'
    );
  });

  it('matches the prefix case-insensitively', () => {
    expect(stripRigPrefix('Rig-Bike: three intents completed.', 'rig-bike')).toBe(
      'three intents completed.'
    );
  });

  it('leaves a line that opens with an unrelated clause intact', () => {
    const line = 'Note: two intents remain open.';
    expect(stripRigPrefix(line, 'rig-bike')).toBe(line);
  });

  it('leaves the line alone when the rig name is unknown', () => {
    const line = 'rig-bike: something happened.';
    expect(stripRigPrefix(line, null)).toBe(line);
  });
});
