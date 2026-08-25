#!/usr/bin/env node
/**
 * Design-token enforcement (charter v2, slice 3). The type ramp and color
 * tokens kept eroding because nothing failed when a component invented
 * `text-[12.5px]` or a raw hex — 24+ arbitrary sizes had accumulated, with
 * 12.5px independently reinvented three times. The ramp is law only if the
 * build says so.
 *
 * Fails on, inside src/renderer component code:
 *   - arbitrary Tailwind font sizes:  text-[Npx] / text-[N.Npx]
 *   - raw hex colors in className strings or inline style objects
 *
 * Deliberately NOT flagged: tokens.css (where hex belongs), index.html's
 * pre-paint script, test files (fixtures may assert on strings), and
 * non-color bracket utilities (w-[...], size-[...] etc. are layout, not
 * token drift).
 *
 * Grandfathered paths carry debt scheduled for the ramp sweep; shrink this
 * list, never grow it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'src', 'renderer');
const GRANDFATHERED = [
  // Pre-charter debt, to be cleared by the ramp sweep. Do not add to this.
  'features/docs/comments/comments-margin.tsx',
];

const TEXT_ARBITRARY = /\btext-\[\d+(?:\.\d+)?px\]/g;
const HEX_IN_CLASSNAME = /(?:className|class)\s*[:=]\s*{?["'`][^"'`]*#[0-9a-fA-F]{3,8}\b/g;
const HEX_IN_STYLE = /(?:color|background(?:Color)?|borderColor|fill|stroke)\s*:\s*["'`]#[0-9a-fA-F]{3,8}\b/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full;
  }
}

const findings = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (GRANDFATHERED.includes(rel)) continue;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const pattern of [TEXT_ARBITRARY, HEX_IN_CLASSNAME, HEX_IN_STYLE]) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) findings.push(`${rel}:${i + 1}  ${match[0].trim().slice(0, 60)}`);
    }
  });
}

if (findings.length > 0) {
  console.error('Design-token violations (use the ramp / tokens, see docs/design-system.md):\n');
  for (const f of findings) console.error('  ' + f);
  console.error(`\n${findings.length} violation(s).`);
  process.exit(2);
}
console.log('design tokens clean');
