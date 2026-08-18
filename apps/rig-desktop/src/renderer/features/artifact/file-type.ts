/**
 * Pure file-type detection for the artifact view (round: beyond-markdown).
 *
 * Today's actual behavior (investigated before this round): `App.tsx`'s
 * `openFile` gated on `.md` and toasted "No preview yet" for anything else
 * — `ArtifactView`/`DocEditor` never even mounted for a non-md file. It
 * never "garbled" a rig.toml; it simply refused to open one. This module
 * replaces that blanket gate with real per-category detection so every
 * file type gets an honest, purpose-built view.
 *
 * Two-tier, by design: EXTENSION first (fast, synchronous, no IO — the
 * overwhelming majority of files) and a binary SNIFF only as the fallback
 * for an extension this module doesn't recognize at all — never the other
 * way around, and never a heuristic on content for a KNOWN extension (a
 * `.json` file with unusual bytes in it is still `.json`).
 */

/**
 * Language id for the editor's CodeMirror extension — deliberately narrow:
 * only languages this app already has real grammar support for (see
 * `doc-editor.tsx`'s own `languageExtension`). Everything still text but
 * without a grammar here (ini, csv, dotfiles like `.gitignore`, …) gets
 * `null` — a real, editable, saveable plain-text buffer with no syntax
 * highlighting, never a fake/wrong grammar and never refused. `null` still
 * gets the mono/code presentation (`doc-editor-theme.ts`'s
 * `docCodeTypography`), not markdown's prose theme — a grammarless config
 * file should read as code, not as a paragraph.
 */
export type EditorLanguage =
  | 'markdown'
  | 'html'
  | 'css'
  | 'js'
  | 'jsx'
  | 'ts'
  | 'tsx'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'shell'
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'sql'
  | 'xml'
  | 'properties'
  | null;

export type DetectedFileType =
  | { category: 'markdown' }
  | { category: 'text'; language: EditorLanguage }
  | { category: 'image'; mime: string }
  | { category: 'unsupported' };

/** The bytes actually sampled for the binary sniff — small, since it only ever needs to answer "does a null byte show up early." */
export const SNIFF_BYTES = 4096;

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

/**
 * Extensions with a real CM6 grammar in this app's dependency tree. The
 * html/css/js family was already here (pulled in transitively by
 * `lang-markdown`'s own embedded-code-block support, now declared
 * directly). This round (mono-theme + real grammars) adds three small,
 * official packages: `@codemirror/lang-json`, `@codemirror/lang-yaml`, and
 * `@codemirror/legacy-modes` (`StreamLanguage`-wrapped ports of CodeMirror
 * 5's language modes — toml plus everything below `yaml`/`json5` in this
 * map). `rig.toml` — in every rig — is the reason toml is a must-have; the
 * rest are wired because `@codemirror/legacy-modes` makes them genuinely
 * trivial (a single named import each) and this app already recognized
 * every one of these extensions as "real text/code" in
 * `KNOWN_TEXT_EXTENSIONS` below, just without a grammar. See
 * `doc-editor.tsx`'s `languageExtension` for the actual CM6 wiring.
 */
const GRAMMAR_LANGUAGE_BY_EXTENSION: Record<string, EditorLanguage> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  sql: 'sql',
  xml: 'xml',
  properties: 'properties',
};

/**
 * Extensions confirmed to be real, common text/code/config formats even
 * though this app has no grammar for them — never needs the binary sniff,
 * and never rendered as "unsupported." Deliberately not exhaustive: an
 * extension NOT in this list (or the grammar map above) still opens as
 * plain text via the sniff fallback below, as long as it doesn't look
 * binary — a config format nobody thought to name here is still editable,
 * just not auto-recognized as "obviously text" without a peek.
 */
const KNOWN_TEXT_EXTENSIONS = new Set([
  'txt',
  'log',
  'ini',
  'cfg',
  'conf',
  'env',
  'php',
  'csv',
  'tsv',
  'gitignore',
  'gitattributes',
  'dockerignore',
  'editorconfig',
  'lock',
]);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  // Rendered as an <img>, never inline DOM — see `image-viewer.tsx`'s own
  // doc comment for why that's the actual script-safety boundary, not
  // whether SVG "is text."
  svg: 'image/svg+xml',
};

/**
 * The extension `detectByExtension` keys on. A dotfile with no OTHER dot
 * (`.gitignore`) uses the part after its leading dot, matching how people
 * actually think of it — not "no extension." `rig.toml` → `toml`;
 * `file.md.bak` → `bak` (a backup of an md file is not itself markdown —
 * the honest answer, not an assumption); `Dockerfile`/`Makefile` (no dot
 * at all) → `''`, falling through to the sniff.
 */
export function extensionOf(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot === -1) return '';
  if (dot === 0) return base.slice(1).toLowerCase();
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Extension-only detection. Returns `null` when the extension isn't
 * recognized at all — the caller's cue to fall back to `looksBinary` on a
 * sampled prefix (`resolveFileType` does exactly that).
 */
export function detectByExtension(filename: string): DetectedFileType | null {
  const ext = extensionOf(filename);
  if (MARKDOWN_EXTENSIONS.has(ext)) return { category: 'markdown' };
  const mime = IMAGE_MIME_BY_EXTENSION[ext];
  if (mime) return { category: 'image', mime };
  const grammarLanguage = GRAMMAR_LANGUAGE_BY_EXTENSION[ext];
  if (grammarLanguage) return { category: 'text', language: grammarLanguage };
  if (KNOWN_TEXT_EXTENSIONS.has(ext)) return { category: 'text', language: null };
  return null;
}

/**
 * The binary sniff: a null byte ANYWHERE in the sampled prefix. The same
 * heuristic git and most editors use — real text (any encoding a text
 * editor cares about, including UTF-16 with a BOM) essentially never
 * contains a literal NUL, while genuinely binary formats (images this
 * module doesn't already recognize by extension, executables, archives)
 * almost always do within the first few KB.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * Full resolution: extension first, the sniff only for what it doesn't
 * recognize. `sniffedBytes` is read once, up front (`SNIFF_BYTES` worth) —
 * callers only need to provide it when `detectByExtension` alone returned
 * `null` (see `use-file-type.ts`, which skips the RPC entirely otherwise).
 */
export function resolveFileType(filename: string, sniffedBytes: Uint8Array): DetectedFileType {
  const byExtension = detectByExtension(filename);
  if (byExtension) return byExtension;
  return looksBinary(sniffedBytes) ? { category: 'unsupported' } : { category: 'text', language: null };
}

/**
 * Human-readable file size for the image viewer's and unsupported-file
 * view's metadata lines — 1000-based (B/KB/MB/GB), matching Finder/most OS
 * file managers rather than the 1024-based "KiB" binary convention.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex++;
  }
  // One decimal place under 10 (e.g. "1.5 KB"), none at or above it (e.g.
  // "12 MB") — but never a trailing ".0" for an exact value either way.
  const precision = value < 10 ? 1 : 0;
  const rounded = value.toFixed(precision);
  const trimmed = rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded;
  return `${trimmed} ${units[unitIndex]}`;
}
