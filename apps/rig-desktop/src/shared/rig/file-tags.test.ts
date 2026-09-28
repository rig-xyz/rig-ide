import { describe, expect, it } from 'vitest';
import { formatFileTag, parseFileTags, rankTaggableFiles } from './file-tags';

const paths = (text: string) => parseFileTags(text).map((t) => t.path);

describe('formatFileTag', () => {
  it('writes plain paths bare and anything else quoted', () => {
    expect(formatFileTag('notes/plan.md')).toBe('+notes/plan.md');
    expect(formatFileTag('data.csv')).toBe('+data.csv');
    expect(formatFileTag('Q3 board deck.pdf')).toBe('+"Q3 board deck.pdf"');
    expect(formatFileTag('Café/menu.pdf')).toBe('+"Café/menu.pdf"');
    // No dot or slash (would read as "+Makefile" text) and digit-only names go quoted too.
    expect(formatFileTag('Makefile')).toBe('+"Makefile"');
    expect(formatFileTag('2024.10')).toBe('+"2024.10"');
  });

  it('refuses what could leave the space or break the quotes', () => {
    expect(formatFileTag('../secret.md')).toBeNull();
    expect(formatFileTag('/etc/hosts')).toBeNull();
    expect(formatFileTag('say "hi".md')).toBeNull();
  });

  it('reads back every tag it writes', () => {
    for (const path of ['notes/plan.md', 'Q3 board deck.pdf', 'Makefile', 'a-b_c/d.e.f', 'Café/menu.pdf']) {
      expect(paths(`see ${formatFileTag(path)} please`)).toEqual([path]);
    }
  });
});

describe('parseFileTags', () => {
  it('finds plain and quoted tags, any file type', () => {
    expect(paths('+notes.md and +"Q3 board deck.pdf" then +img/shot.png')).toEqual(['notes.md', 'Q3 board deck.pdf', 'img/shot.png']);
  });

  it("leaves the sentence's own punctuation outside the tag", () => {
    expect(paths('Look at +notes/plan.md.')).toEqual(['notes/plan.md']);
    expect(paths('(+data.csv), +a/b.md; +c.md!')).toEqual(['data.csv', 'a/b.md', 'c.md']);
  });

  it('leaves emails, sums, "+1" and C++ alone', () => {
    expect(paths('mail dylan+test@play.local or a+b.md')).toEqual([]);
    expect(paths('+1 on that, +1.5 points, C++ and 2+2.5')).toEqual([]);
  });

  it('never lets a tag leave the space', () => {
    expect(paths('+../secret.md +notes/../../x.md +"../up.pdf" +"/etc/hosts"')).toEqual([]);
  });

  it('keeps +x.md working, with its position', () => {
    expect(parseFileTags('hi +x.md')).toEqual([{ path: 'x.md', index: 3, length: 5 }]);
  });
});

describe('rankTaggableFiles', () => {
  const files = [
    { relPath: 'docs/roadmap.md', name: 'roadmap.md', mtimeMs: 1 },
    { relPath: 'attachments/Q3 board deck.pdf', name: 'Q3 board deck.pdf', mtimeMs: 3 },
    { relPath: 'research/interviews.md', name: 'interviews.md', mtimeMs: 2 },
    { relPath: 'road/notes.txt', name: 'notes.txt', mtimeMs: 4 },
  ];

  it('most recently changed first with nothing typed', () => {
    expect(rankTaggableFiles(files, '').map((f) => f.name)).toEqual(['notes.txt', 'Q3 board deck.pdf', 'interviews.md', 'roadmap.md']);
  });

  it('name matches before path matches, fuzzy last', () => {
    expect(rankTaggableFiles(files, 'road').map((f) => f.name)).toEqual(['roadmap.md', 'notes.txt']);
    expect(rankTaggableFiles(files, 'q3d').map((f) => f.name)).toEqual(['Q3 board deck.pdf']);
    expect(rankTaggableFiles(files, 'zzz')).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ relPath: `f${i}.md`, name: `f${i}.md` }));
    expect(rankTaggableFiles(many, '')).toHaveLength(200);
  });
});
