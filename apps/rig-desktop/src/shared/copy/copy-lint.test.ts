import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * House rules for words people read on the first-run and invite screens:
 * no clauses joined with a spaced dash, and none of the internal words
 * "runnable" or "rigs". Reads the string literals and JSX text of these
 * files; comments, log lines and developer-only messages are left out.
 */

const SRC = join(__dirname, '..', '..');
const DIRS = ['renderer/features/home', 'renderer/features/onboarding', 'renderer/features/deep-link', 'renderer/features/rig-share'];
const FILES = ['main/rig/rig-share.ts', 'main/rig/comment-agent.ts'];
/** Rows of the plain-rigs list, shown only when Settings shows plain rigs: there, rigs is the right word. */
const SKIP_FILES = new Set(['renderer/features/home/rigs-rail.tsx']);

/** Not copy: CSS, code, log lines, and messages only a developer sees (RIG_RELAY_URL set by hand). */
const NOT_COPY = [/^calc\(/, /^Rig comment agent:/, /^auto-declining/, /^RIG_RELAY_URL /, /^rig: /];

const BAD = /\s[-–—]\s|\brunnable\b|\brigs\b/i;

function sources(): string[] {
  const files = DIRS.flatMap((dir) =>
    readdirSync(join(SRC, dir))
      .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
      .map((name) => `${dir}/${name}`)
  );
  return [...files, ...FILES].filter((file) => !SKIP_FILES.has(file));
}

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Sentences in a file: string literals and JSX text with a space in them. */
function sentences(code: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  const pattern = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|>([^<>{}]*[A-Za-z][^<>{}]*)</g;
  for (const match of code.matchAll(pattern)) {
    // A template's ${…} parts are code; only its words are copy.
    const text = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').replace(/\$\{[^}]*\}/g, 'x').trim();
    // Code between JSX tags (`a - b`, arrow bodies) is not a sentence.
    if (!text.includes(' ') || /[;=]|=>|\bconst\b|\breturn\b/.test(text)) continue;
    if (NOT_COPY.some((re) => re.test(text))) continue;
    found.push({ line: code.slice(0, match.index).split('\n').length, text });
  }
  return found;
}

describe('first-run and invite copy', () => {
  it('has no spaced dashes, and never says runnable or rigs', () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
      for (const { line, text } of sentences(code)) {
        if (BAD.test(text)) offenders.push(`${relative(SRC, join(SRC, file))}:${line}: ${text.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
