import { describe, expect, it } from 'vitest';
import { FILE_ICON_ASSETS, FILE_ICON_TINT, fileIconTypeFor } from './file-icon';

describe('fileIconTypeFor', () => {
  it('maps table extensions', () => {
    expect(fileIconTypeFor('data.csv')).toBe('table');
    expect(fileIconTypeFor('data.tsv')).toBe('table');
    expect(fileIconTypeFor('data.xlsx')).toBe('table');
  });

  it('maps image extensions', () => {
    expect(fileIconTypeFor('photo.png')).toBe('image');
    expect(fileIconTypeFor('photo.jpg')).toBe('image');
    expect(fileIconTypeFor('photo.jpeg')).toBe('image');
    expect(fileIconTypeFor('photo.gif')).toBe('image');
    expect(fileIconTypeFor('photo.webp')).toBe('image');
    expect(fileIconTypeFor('icon.svg')).toBe('image');
  });

  it('maps archive extensions', () => {
    expect(fileIconTypeFor('bundle.zip')).toBe('archive');
    expect(fileIconTypeFor('bundle.tar')).toBe('archive');
    expect(fileIconTypeFor('bundle.gz')).toBe('archive');
    expect(fileIconTypeFor('bundle.tgz')).toBe('archive');
    expect(fileIconTypeFor('bundle.rar')).toBe('archive');
    expect(fileIconTypeFor('bundle.7z')).toBe('archive');
  });

  it('falls back to document for markdown, known text, and unrecognized extensions alike', () => {
    expect(fileIconTypeFor('positioning.md')).toBe('document');
    expect(fileIconTypeFor('notes.txt')).toBe('document');
    expect(fileIconTypeFor('config.yaml')).toBe('document');
    expect(fileIconTypeFor('whatever.zzz')).toBe('document');
    expect(fileIconTypeFor('.gitignore')).toBe('document');
  });

  it('is case-insensitive on the extension', () => {
    expect(fileIconTypeFor('DATA.CSV')).toBe('table');
    expect(fileIconTypeFor('PHOTO.PNG')).toBe('image');
  });

  it('never returns skill — that is a path decision, not an extension one', () => {
    for (const name of ['SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'sparkle.md']) {
      expect(fileIconTypeFor(name)).not.toBe('skill');
    }
  });
});

describe('FILE_ICON_ASSETS / FILE_ICON_TINT', () => {
  it('has an asset and a tint for every icon type', () => {
    const types = Object.keys(FILE_ICON_ASSETS) as (keyof typeof FILE_ICON_ASSETS)[];
    expect(types.sort()).toEqual(
      ['archive', 'document', 'image', 'note', 'skill', 'table'].sort()
    );
    for (const type of types) {
      expect(FILE_ICON_ASSETS[type].src1x).toBeTruthy();
      expect(FILE_ICON_ASSETS[type].src2x).toBeTruthy();
      expect(FILE_ICON_TINT[type]).toMatch(/^(neutral|accent)$/);
    }
  });

  it('tints skill as accent and everything else neutral', () => {
    expect(FILE_ICON_TINT.skill).toBe('accent');
    for (const type of ['document', 'table', 'image', 'note', 'archive'] as const) {
      expect(FILE_ICON_TINT[type]).toBe('neutral');
    }
  });
});
