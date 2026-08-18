import { describe, expect, it } from 'vitest';
import { detectByExtension, extensionOf, formatFileSize, looksBinary, resolveFileType } from './file-type';

describe('extensionOf', () => {
  it('the common case', () => {
    expect(extensionOf('rig.toml')).toBe('toml');
    expect(extensionOf('notes.md')).toBe('md');
  });

  it('a full path — only the basename matters', () => {
    expect(extensionOf('/Users/dylan/rig/docs/plan.md')).toBe('md');
  });

  it('a dotfile with no other dot uses the part after the leading dot', () => {
    expect(extensionOf('.gitignore')).toBe('gitignore');
    expect(extensionOf('.env')).toBe('env');
  });

  it('the LAST dot wins for a multi-dot name — a backup of an md file is not itself md', () => {
    expect(extensionOf('file.md.bak')).toBe('bak');
  });

  it('no dot at all (Dockerfile, Makefile, LICENSE) — empty string', () => {
    expect(extensionOf('Dockerfile')).toBe('');
    expect(extensionOf('LICENSE')).toBe('');
  });

  it('case-insensitive', () => {
    expect(extensionOf('README.MD')).toBe('md');
  });
});

describe('detectByExtension', () => {
  it('markdown', () => {
    expect(detectByExtension('notes.md')).toEqual({ category: 'markdown' });
    expect(detectByExtension('notes.mdx')).toEqual({ category: 'markdown' });
    expect(detectByExtension('notes.markdown')).toEqual({ category: 'markdown' });
  });

  it('images, each with the right mime — svg included, resolved the same as any other image', () => {
    expect(detectByExtension('logo.png')).toEqual({ category: 'image', mime: 'image/png' });
    expect(detectByExtension('photo.jpg')).toEqual({ category: 'image', mime: 'image/jpeg' });
    expect(detectByExtension('photo.jpeg')).toEqual({ category: 'image', mime: 'image/jpeg' });
    expect(detectByExtension('anim.gif')).toEqual({ category: 'image', mime: 'image/gif' });
    expect(detectByExtension('pic.webp')).toEqual({ category: 'image', mime: 'image/webp' });
    expect(detectByExtension('icon.svg')).toEqual({ category: 'image', mime: 'image/svg+xml' });
  });

  it('text with a real CM6 grammar package — html/css/js/jsx/ts/tsx/json/yaml', () => {
    expect(detectByExtension('index.html')).toEqual({ category: 'text', language: 'html' });
    expect(detectByExtension('style.css')).toEqual({ category: 'text', language: 'css' });
    expect(detectByExtension('app.js')).toEqual({ category: 'text', language: 'js' });
    expect(detectByExtension('app.mjs')).toEqual({ category: 'text', language: 'js' });
    expect(detectByExtension('component.jsx')).toEqual({ category: 'text', language: 'jsx' });
    expect(detectByExtension('lib.ts')).toEqual({ category: 'text', language: 'ts' });
    expect(detectByExtension('component.tsx')).toEqual({ category: 'text', language: 'tsx' });
    expect(detectByExtension('data.json')).toEqual({ category: 'text', language: 'json' });
    expect(detectByExtension('data.jsonc')).toEqual({ category: 'text', language: 'json' });
    expect(detectByExtension('data.json5')).toEqual({ category: 'text', language: 'json' });
    expect(detectByExtension('config.yaml')).toEqual({ category: 'text', language: 'yaml' });
    expect(detectByExtension('config.yml')).toEqual({ category: 'text', language: 'yaml' });
  });

  it('text with a legacy-modes (StreamLanguage) grammar — round: mono theme + real grammars', () => {
    // `rig.toml` is in every rig — the forcing case for this round.
    expect(detectByExtension('rig.toml')).toEqual({ category: 'text', language: 'toml' });
    expect(detectByExtension('deploy.sh')).toEqual({ category: 'text', language: 'shell' });
    expect(detectByExtension('run.bash')).toEqual({ category: 'text', language: 'shell' });
    expect(detectByExtension('script.py')).toEqual({ category: 'text', language: 'python' });
    expect(detectByExtension('app.rb')).toEqual({ category: 'text', language: 'ruby' });
    expect(detectByExtension('main.go')).toEqual({ category: 'text', language: 'go' });
    expect(detectByExtension('lib.rs')).toEqual({ category: 'text', language: 'rust' });
    expect(detectByExtension('main.c')).toEqual({ category: 'text', language: 'c' });
    expect(detectByExtension('main.cpp')).toEqual({ category: 'text', language: 'cpp' });
    expect(detectByExtension('Main.java')).toEqual({ category: 'text', language: 'java' });
    expect(detectByExtension('Main.kt')).toEqual({ category: 'text', language: 'kotlin' });
    expect(detectByExtension('App.swift')).toEqual({ category: 'text', language: 'swift' });
    expect(detectByExtension('query.sql')).toEqual({ category: 'text', language: 'sql' });
    expect(detectByExtension('feed.xml')).toEqual({ category: 'text', language: 'xml' });
    expect(detectByExtension('app.properties')).toEqual({ category: 'text', language: 'properties' });
  });

  it('known text/config formats with genuinely no grammar — plain text, language null, never refused', () => {
    expect(detectByExtension('app.log')).toEqual({ category: 'text', language: null });
    expect(detectByExtension('readme.txt')).toEqual({ category: 'text', language: null });
    expect(detectByExtension('settings.ini')).toEqual({ category: 'text', language: null });
    expect(detectByExtension('.env')).toEqual({ category: 'text', language: null });
  });

  it('a dotfile known to be text', () => {
    expect(detectByExtension('.gitignore')).toEqual({ category: 'text', language: null });
  });

  it('unrecognized extension — null, the caller must fall back to the sniff', () => {
    expect(detectByExtension('archive.zip')).toBeNull();
    expect(detectByExtension('mystery.xyz')).toBeNull();
  });

  it('no extension at all — null, same fallback', () => {
    expect(detectByExtension('Dockerfile')).toBeNull();
    expect(detectByExtension('LICENSE')).toBeNull();
  });

  it('a backup of a markdown file is honestly plain text, not markdown', () => {
    expect(detectByExtension('notes.md.bak')).toBeNull(); // 'bak' unrecognized — sniff decides
  });
});

describe('looksBinary', () => {
  it('a null byte anywhere in the sample — binary', () => {
    expect(looksBinary(new Uint8Array([72, 101, 0, 108, 111]))).toBe(true);
    expect(looksBinary(new Uint8Array([0]))).toBe(true);
  });

  it('a null byte as the very last sampled byte still counts', () => {
    expect(looksBinary(new Uint8Array([72, 101, 108, 108, 0]))).toBe(true);
  });

  it('plain ASCII/UTF-8 text — never binary', () => {
    const bytes = new TextEncoder().encode('#!/usr/bin/env bash\necho "hello"\n');
    expect(looksBinary(bytes)).toBe(false);
  });

  it('an empty sample — never binary (nothing to find)', () => {
    expect(looksBinary(new Uint8Array([]))).toBe(false);
  });
});

describe('resolveFileType', () => {
  it('a recognized extension never even looks at the sniff bytes', () => {
    // A "binary-looking" sample is ignored entirely once the extension alone answers it.
    expect(resolveFileType('notes.md', new Uint8Array([0, 0, 0]))).toEqual({ category: 'markdown' });
  });

  it('an unrecognized extension with no binary signal — plain text', () => {
    const textBytes = new TextEncoder().encode('some config content\nkey = value\n');
    expect(resolveFileType('mystery.xyz', textBytes)).toEqual({ category: 'text', language: null });
  });

  it('an unrecognized extension WITH a binary signal — unsupported', () => {
    expect(resolveFileType('mystery.xyz', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]))).toEqual({
      category: 'unsupported',
    });
  });

  it('an extensionless file (Dockerfile) that is genuinely text — resolves to plain text via the sniff, never refused', () => {
    const bytes = new TextEncoder().encode('FROM node:22\nWORKDIR /app\n');
    expect(resolveFileType('Dockerfile', bytes)).toEqual({ category: 'text', language: null });
  });

  it('an extensionless file that is genuinely binary — unsupported', () => {
    expect(resolveFileType('a.out', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1]))).toEqual({
      category: 'unsupported',
    });
  });
});

describe('formatFileSize', () => {
  it('bytes, unscaled', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(999)).toBe('999 B');
  });

  it('KB, MB, GB — 1000-based, matching Finder', () => {
    expect(formatFileSize(1000)).toBe('1 KB');
    expect(formatFileSize(1_500)).toBe('1.5 KB');
    expect(formatFileSize(2_400_000)).toBe('2.4 MB');
    expect(formatFileSize(3_200_000_000)).toBe('3.2 GB');
  });

  it('drops the decimal once the value reaches double digits', () => {
    expect(formatFileSize(12_400_000)).toBe('12 MB');
  });
});
