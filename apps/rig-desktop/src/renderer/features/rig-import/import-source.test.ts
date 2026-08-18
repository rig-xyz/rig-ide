import { describe, expect, it } from 'vitest';
import { deriveImportSource, importWorkingLabel } from './import-source';

const DOC_URL = 'https://docs.google.com/document/d/1AbC_def-123/edit#heading=h.x';

describe('deriveImportSource', () => {
  it('is empty-and-quiet with nothing entered in link mode', () => {
    expect(deriveImportSource({ mode: 'link', url: '', filePath: null })).toEqual({
      source: null,
      urlError: null,
    });
    expect(deriveImportSource({ mode: 'link', url: '   ', filePath: null })).toEqual({
      source: null,
      urlError: null,
    });
  });

  it('derives a url source from a valid Docs link', () => {
    expect(deriveImportSource({ mode: 'link', url: DOC_URL, filePath: null })).toEqual({
      source: { kind: 'url', url: DOC_URL },
      urlError: null,
    });
  });

  it('errors a non-Docs link only once something was typed', () => {
    expect(
      deriveImportSource({ mode: 'link', url: 'https://example.com/doc', filePath: null })
    ).toEqual({
      source: null,
      urlError: "That doesn't look like a Google Docs link.",
    });
  });

  it('derives the picked file in docx mode, ignoring the URL box entirely', () => {
    expect(deriveImportSource({ mode: 'docx', url: 'garbage', filePath: '/tmp/report.docx' })).toEqual(
      { source: { kind: 'file', path: '/tmp/report.docx' }, urlError: null }
    );
    // No file picked yet: nothing usable, but no scolding either.
    expect(deriveImportSource({ mode: 'docx', url: 'garbage', filePath: null })).toEqual({
      source: null,
      urlError: null,
    });
  });

  it('keeps the other mode’s entry intact but inert across a mode switch', () => {
    const filled = { url: DOC_URL, filePath: '/tmp/report.docx' };
    expect(deriveImportSource({ mode: 'link', ...filled }).source).toEqual({
      kind: 'url',
      url: DOC_URL,
    });
    expect(deriveImportSource({ mode: 'docx', ...filled }).source).toEqual({
      kind: 'file',
      path: '/tmp/report.docx',
    });
  });
});

describe('importWorkingLabel', () => {
  it('names the picked file, and stays honest about an unfetched link', () => {
    expect(
      importWorkingLabel({ mode: 'docx', url: '', filePath: '/x/Knee Plan.docx' })
    ).toBe('Knee Plan.docx');
    expect(importWorkingLabel({ mode: 'link', url: DOC_URL, filePath: null })).toBe(
      'your Google Doc'
    );
  });
});
