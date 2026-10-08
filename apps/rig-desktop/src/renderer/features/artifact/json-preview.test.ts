import { describe, expect, it } from 'vitest';
import { highlightJson, isJsonPreviewPath, prettyJson } from './json-preview';

describe('isJsonPreviewPath', () => {
  it('is .json and .geojson', () => {
    expect(isJsonPreviewPath('/a/data.json')).toBe(true);
    expect(isJsonPreviewPath('/a/map.geojson')).toBe(true);
    expect(isJsonPreviewPath('/a/MAP.GeoJSON')).toBe(true);
    expect(isJsonPreviewPath('/a/tsconfig.jsonc')).toBe(false);
    expect(isJsonPreviewPath('/a/notes.md')).toBe(false);
  });
});

describe('prettyJson', () => {
  it('prints with two-space indent', () => {
    expect(prettyJson('{"a":[1,{"b":null}],"c":"d"}')).toBe('{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": "d"\n}');
  });

  it('is null for text that does not parse', () => {
    expect(prettyJson('{"a": 1,}')).toBeNull();
    expect(prettyJson('')).toBeNull();
  });
});

describe('highlightJson', () => {
  it('keeps the text, line by line, and colors keys like the code editor', () => {
    const lines = highlightJson('{\n  "a": 1\n}');
    expect(lines.map((line) => line.map((s) => s.text).join(''))).toEqual(['{', '  "a": 1', '}']);
    const key = lines[1]!.find((s) => s.text === '"a"');
    expect(key?.className).toContain('text-accent');
    expect(lines[1]!.find((s) => s.text === '1')?.className).toContain('text-text-secondary');
  });
});
